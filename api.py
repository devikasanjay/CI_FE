"""
Entry points and running of the API
Controllers:
- ChatAPI (ThreadAPI) - Allows creating completions, updating threads, reading history and CRUD for conversation state
- FileAPI (FileAPI) - Management of files including upload of files into the system

"""
import os
import json
import logging
import datetime
import uuid
import asyncio
import traceback
from pathlib import Path
import re
from components.controllers.contract_management import (
    ManualContractWorkspaceCreateReq,
    AribaContractWorkspaceCreateReq,
    ContractWorkspaceUpdateReq,
    get_contract_management_controller,
)
from components.controllers.attribute_management import (
    SubmitFormData,
    get_attrb_management_controller,
    AttributePageService,
    ExecutionTimeEstimate,
)
from components.controllers.template_management import (
    get_custom_panel_management_controller,
    CustomPanelCreateReq,
    CustomPanelUpdateReq,
    KnowledgeBaseSchemaCreateReq,
    KnowledgeBaseSchemaUpdateReq
)
from components.controllers.ariba_management import get_ariba_management_controller
from components.controllers.contract_comparison import EmbedService
from fastapi.responses import (
    StreamingResponse,
    FileResponse,
    RedirectResponse,
    HTMLResponse,
)
from typing import List, Optional
from fastapi import (
    APIRouter,
    FastAPI,
    File,
    UploadFile,
    Depends,
    HTTPException,
    Request,
    Query,
    Response,
)

from pathlib import Path as FilePath
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from starlette.responses import JSONResponse
from fastapi.security import OAuth2PasswordBearer
from starlette.exceptions import HTTPException as StarletteHTTPException

from components.models.auth import Role, User
from components.models.base import Base
from components.models.contract import Contract
from components.models.index import Index
from components.models.file import File as FileModel
from components.models.thread import Thread, Message

from services.storage import AzureStorageClient
from components.controllers.thread import ThreadAPIController

from utils.auth_helper import (
    AuthorizationMiddleware,
    GetAToken,
    UserIdentitySchema,
    acquire_token_by_authorization_code,
    auth_check,
    create_access_token,
    find_client_details_from_email_domain,
    get_user_details_from_azure_token,
    refresh_access_token,
)
from utils.constants import *
from utils.exceptions import (
    AuthException,
    CustomException,
    prepare_error_payload,
    prepare_success_payload,
)
import traceback
import asyncio
from pydantic import BaseModel
import logging
import logging_config
from logging_config import correlation_id_var
from starlette.middleware.base import BaseHTTPMiddleware


logging_config.setup_logging()
logger = logging.getLogger(__name__)


class CorrelationIdMiddleware:
    """
    ASGI middleware to maintain correlation ID context.
    Correlation ID is expected from frontend; creates one only if missing (corner case).
    """
    def __init__(self, app):
        self.app = app
    
    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Extract headers from scope
        headers = dict(scope.get("headers", []))
        
        # Get correlation ID from header, or generate as corner case
        correlation_id = headers.get(b"x-request-id")
        correlation_id = correlation_id.decode("utf-8") if correlation_id else str(uuid.uuid4())
        
        # Set correlation ID in context variable
        token = correlation_id_var.set(correlation_id)
        
        # Store in scope for request.state access
        if "state" not in scope:
            scope["state"] = {}
        scope["state"]["correlation_id"] = correlation_id
        
        async def send_with_correlation_id(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((b"x-request-id", correlation_id.encode("utf-8")))
                message["headers"] = headers
            await send(message)
        
        try:
            await self.app(scope, receive, send_with_correlation_id)
        finally:
            correlation_id_var.reset(token)

frontend_settings = {
    "auth_enabled": os.getenv("AUTH_ENABLED", "true").lower() == "true",
    "feedback_enabled": "conversations",
    "ui": {
        "title": os.getenv("UI_TITLE", "Contract Intelligence"),
        "logo": os.getenv("UI_LOGO"),
        "chat_logo": os.getenv("UI_CHAT_LOGO"),
        "chat_title": os.getenv("UI_CHAT_TITLE", "Start chatting"),
        "chat_description": os.getenv(
            "UI_CHAT_DESCRIPTION", "This chatbot is configured to answer your questions"
        ),
        "show_share_button": os.getenv("UI_SHOW_SHARE_BUTTON", "true").lower()
        == "true",
    },
    "sanitize_answer": os.getenv("SANITIZE_ANSWER", "false").lower() == "true",
}


app = FastAPI(
    title="Contract Intelligence Application",
    version="1.0",
    description="A GenAI application that retrieves information from Contract docs",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows all origins
    allow_credentials=True,
    # allow_methods=["*"],  # Allows all methods
    # allow_headers=["*"],  # Allows all headers
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Request-ID"],
)
app.add_middleware(CorrelationIdMiddleware)
app.add_middleware(AuthorizationMiddleware)

generic_router = APIRouter()
auth_router = APIRouter(prefix="/api/auth")
blob_router = APIRouter(prefix="/api/blob", dependencies=[Depends(auth_check)])
user_router = APIRouter(prefix="/api/users", dependencies=[Depends(auth_check)])
chat_router = APIRouter(
    prefix="/api/chat", dependencies=[Depends(auth_check)]
)  # , Depends(contract_workspace_check)
contract_management_router = APIRouter(
    prefix="/api/contract-mgmt", dependencies=[Depends(auth_check)]
)
attribute_management_router = APIRouter(
    prefix="/api/attribute-mgmt", dependencies=[Depends(auth_check)]
)
contract_comparison_router = APIRouter(
    prefix="/api/contract-comparison", dependencies=[Depends(auth_check)]
)
generic_secured_router = APIRouter(prefix="/api", dependencies=[Depends(auth_check)])
template_management_router = APIRouter(
    prefix="/api/template-mgmt", dependencies=[Depends(auth_check)]
)
ariba_management_router = APIRouter(
    prefix="/api/ariba-mgmt", dependencies=[Depends(auth_check)]
)


@generic_router.get("/health")
async def health_check(request: Request):
    """Health check endpoint that also tests correlation ID"""
    logger.info("Health check endpoint called")
    correlation_id = correlation_id_var.get()
    return {
        "status": "healthy",
        "correlation_id": correlation_id or "NOT_SET",
        "correlation_id_from_state": getattr(request.state, "correlation_id", "NO_STATE")
    }


@generic_router.get("/", response_class=HTMLResponse)
async def index():
    logger.info("Serving index.html")
    html_content = """
    <html>
        <head>
            <title>Contract Intelligence Application API</title>
            <style>
                body { font-family: Arial, sans-serif; background: #f8f9fa; padding: 50px; }
                h1 { color: #003366; }
                a { color: #0056b3; }
                .info { margin-top: 20px; font-size: 1.1em; }
                .links { margin-top: 20px; }
            </style>
        </head>
        <body>
            <h1>Welcome to the Contract Intelligence Application API</h1>
            <div class="info">
                Explore and interact with our contract intelligence endpoints.
            </div>
            <div class="links">
                <ul>
                    <li><a href="/docs">Swagger Documentation</a></li>
                    <li><a href="/redoc">Redoc Documentation</a></li>
                </ul>
            </div>
            <div class="info">
                API Version: <b>1.0.0</b><br>
                Status: <span style="color:green;">Operational</span>
            </div>
        </body>
    </html>
    """
    return HTMLResponse(content=html_content)


@generic_router.get("/assets/{path:path}")
async def read_asset(path: str):
    base_dir = Path("static/assets").resolve()

    # Normalize the path to prevent traversal
    normalized_path = Path(path).parts
    safe_path = Path(*[part for part in normalized_path if part not in ("..", "/")])

    asset_path = (base_dir / safe_path).resolve()

    # Check if the resolved path is within the base directory
    if not asset_path.is_file() or not asset_path.is_relative_to(base_dir):
        logger.error(f"File not found: {asset_path}")
        raise HTTPException(status_code=404, detail="File not found")

    logger.info(f"Serving asset: {asset_path}")
    return FileResponse(str(asset_path))


@app.exception_handler(HTTPException)
async def custom_error_handler(request: Request, exc: HTTPException):
    logger.error(f"HTTPException occurred: {exc.detail}")
    return JSONResponse(status_code=exc.status_code, content=exc.detail)


@app.exception_handler(StarletteHTTPException)
async def custom_404_handler(request: Request, exc: StarletteHTTPException):
    if exc.status_code == 404:
        logger.warning("404 error encountered, serving index.html")
        return FileResponse("static/index.html")
    logger.error(f"StarletteHTTPException occurred: {exc.detail}")
    return JSONResponse(status_code=exc.status_code, content=exc.detail)


@generic_router.get("/src/assets/images/{path:path}")
async def read_asset_images(path: str):
    base_dir = Path("static/src/assets/images").resolve()

    # Normalize the path to prevent traversal
    normalized_path = Path(path).parts
    safe_path = Path(*[part for part in normalized_path if part not in ("..", "/")])

    asset_path = (base_dir / safe_path).resolve()

    # Check if the resolved path is within the base directory
    if not asset_path.is_file() or not asset_path.is_relative_to(base_dir):
        logger.error(f"Image file not found: {asset_path}")
        raise HTTPException(status_code=404, detail="File not found")

    logger.info(f"Serving image asset: {asset_path}")
    return FileResponse(str(asset_path))


@generic_router.get("/favicon.ico", include_in_schema=False)
async def favicon():
    favicon_path = os.getenv("UI_FAVICON")
    local_favicon_path = os.getenv("UI_LOCAL_FAVICON")
    static_dir = FilePath("static").resolve()

    def safe_file_response(path):
        resolved_path = FilePath(path).resolve()
        if str(resolved_path).startswith(str(static_dir)) and resolved_path.is_file():
            logger.info(f"Serving favicon: {resolved_path}")
            return FileResponse(str(resolved_path))
        logger.error(f"Favicon file not found: {resolved_path}")
        raise HTTPException(status_code=404, detail="File not found")

    if favicon_path and favicon_path.startswith("http"):
        logger.info(f"Redirecting to favicon URL: {favicon_path}")
        return RedirectResponse(url=favicon_path)
    elif favicon_path:
        return safe_file_response(favicon_path)
    elif local_favicon_path:
        return safe_file_response(local_favicon_path)
    else:
        logger.error("Favicon not found")
        raise HTTPException(status_code=404, detail="Favicon not found")


@generic_router.get("/frontend_settings")
async def get_frontend_settings():
    try:
        logger.info("Fetching frontend settings")
        return frontend_settings
    except Exception as e:
        logger.exception("Exception occurred while fetching frontend settings")
        return {"error": str(e)}


## CHAT
def get_chat_controller(request: Request):
    return ThreadAPIController(request.state.index_name, request.state.user_id)


@chat_router.get("/")
async def read_root(request: Request):
    try:
        logger.info("Reading chat root")
        chat_controller = get_chat_controller(request)
        return await chat_controller.read_root()
    except Exception as e:
        logger.exception("Exception occurred in read_root")
        return JSONResponse(status_code=500, content={"error": str(e)})


@chat_router.post("/threads/")
async def add_thread(request: Request, thread: dict):
    try:
        logger.info("Adding new thread")
        chat_controller = get_chat_controller(request)
        return await chat_controller.add_thread(**thread)
    except Exception as e:
        logger.exception("Exception occurred while adding thread")
        return JSONResponse(status_code=500, content={"error": str(e)})


@chat_router.get("/threads/{thread_id}")
async def get_thread(request: Request, thread_id: str):
    try:
        logger.info(f"Fetching thread with ID: {thread_id}")
        chat_controller = get_chat_controller(request)
        return await chat_controller.get_thread(thread_id)
    except Exception as e:
        logger.exception(f"Exception occurred while fetching thread {thread_id}")
        return JSONResponse(status_code=500, content={"error": str(e)})


@chat_router.delete("/threads/{thread_id}")
async def delete_thread(request: Request, thread_id: str):
    try:
        logger.info(f"Deleting thread with ID: {thread_id}")
        chat_controller = get_chat_controller(request)
        return await chat_controller.delete_thread(thread_id)
    except Exception as e:
        logger.exception(f"Exception occurred while deleting thread {thread_id}")
        return JSONResponse(status_code=500, content={"error": str(e)})


@chat_router.get("/threads/")
async def list_threads(body: dict, request: Request):
    try:
        logger.info("Listing all threads")
        chat_controller = get_chat_controller(request)
        return await chat_controller.list_threads(**body)
    except Exception as e:
        logger.exception("Exception occurred while listing threads")
        return JSONResponse(status_code=500, content={"error": str(e)})


@chat_router.delete("/threads/")
async def delete_all_threads(request: Request):
    try:
        logger.info("Deleting all threads")
        chat_controller = get_chat_controller(request)
        return await chat_controller.delete_all_threads()
    except Exception as e:
        logger.exception("Exception occurred while deleting all threads")
        return JSONResponse(status_code=500, content={"error": str(e)})


@chat_router.delete("/threads/{thread_id}/messages")
async def clear_messages(request: Request, thread_id: str):
    try:
        logger.info(f"Clearing messages for thread ID: {thread_id}")
        chat_controller = get_chat_controller(request)
        return await chat_controller.clear_messages(thread_id)
    except Exception as e:
        logger.exception(
            f"Exception occurred while clearing messages for thread {thread_id}"
        )
        return JSONResponse(status_code=500, content={"error": str(e)})


@chat_router.post("/threads/{thread_id}/messages/{message_id}")
async def update_message_feedback(request: Request):
    try:
        logger.info("Updating message feedback")
        chat_controller = get_chat_controller(request)
        data = await request.json()
        thread_id = data.get("conversation_id")
        message_id = data.get("message_id")
        message_feedback = data.get("message_feedback")
        additional_feedback = data.get("additional_feedback")
        feedback = json.dumps(
            {
                "reasons": message_feedback.split(","),
                "additional_feedback": additional_feedback,
            }
        )
        return await chat_controller.update_message_feedback(
            thread_id, message_id, feedback
        )
    except Exception as e:
        logger.exception("Exception occurred while updating message feedback")
        return JSONResponse(status_code=500, content={"error": str(e)})


@chat_router.get("/history/ensure")
async def ensure_cosmos(request: Request):
    logger.info("Ensuring Cosmos DB setup")
    return {"message": "done"}


@chat_router.delete("/history/delete")
async def delete_thread_history(request: Request):
    try:
        logger.info("Deleting thread history")
        chat_controller = get_chat_controller(request)
        data = await request.json()
        thread_id = data.get("conversation_id")
        return await chat_controller.delete_thread(thread_id)
    except Exception as e:
        logger.exception("Exception occurred while deleting thread history")
        return JSONResponse(status_code=500, content={"error": str(e)})


@chat_router.post("/history/generate/old")
async def add_conversation(request: Request):
    try:
        logger.info("Adding old conversation")
        chat_controller = get_chat_controller(request)
        data = await request.json()
        thread_id = data.get("conversation_id")
        messages = data.get("messages")
        response = await chat_controller.add_thread(messages, thread_id)
        return json.dumps(response, default=str)
    except Exception as e:
        logger.exception("Exception occurred while adding conversation")
        return JSONResponse(status_code=500, content={"error": str(e)})


## USED
@chat_router.get("/citation")
async def get_citation(request: Request, file_id: int, page_label: int):
    logger.info(f"Fetching citation for file_id: {file_id}, page_label: {page_label}")
    citation_url = ""
    page_label = page_label - 1
    user_id = request.state.user_id
    try:
        file = FileModel.fetch_file_by_id_and_user(file_id, user_id)
        if file:
            storage = AzureStorageClient("sections")
            citation_url = storage.get_proxy_url_for_page(
                file, page_label, request.state.access_token
            )
    except Exception as e:
        logger.exception("Unable to fetch citation from the give file and page")
        return JSONResponse(status_code=500, content={"error": str(e)})

    addidtional_data = []
    try:
        query = text(
            """
            SELECT cq.question as parameter, ca.answer as value
            FROM contract_intelligence.contract_answer ca
            LEFT JOIN contract_intelligence.contract_question cq
            ON ca.question_id = cq.question_id
            WHERE EXISTS (
                SELECT 1
                FROM jsonb_array_elements(ca.metadata_->'source_nodes') AS nodes
                WHERE (nodes->>'file_id')::int = :file_id
                AND (nodes->>'page_label')::int = :page_label
            ) AND ca.answer <> 'N/A';
            """
        )
        result = Base.get_session().execute(
            query, {"file_id": file_id, "page_label": page_label}
        )
        if result:
            for row in result:
                addidtional_data.append({"parameter": row[0], "value": row[1]})
    except Exception as e:
        logger.exception(
            "Unable to fetch additional parameters from the given file and page"
        )
        return JSONResponse(status_code=500, content={"error": str(e)})

    return JSONResponse(
        content={"citation_url": citation_url, "addidtional_data": addidtional_data}
    )


## USED
@chat_router.post("/threads/{thread_id}")
async def update_thread(request: Request, thread_id: str, thread: dict):
    try:
        logger.info(f"Updating thread with ID: {thread_id}")
        chat_controller = get_chat_controller(request)
        return await chat_controller.update_thread(**thread, thread_id=thread_id)
    except Exception as e:
        logger.exception(f"Exception occurred while updating thread {thread_id}")
        return JSONResponse(status_code=500, content={"error": str(e)})


## USED
@chat_router.get("/history/list")
async def list_history(request: Request, offset: int = 0):
    try:
        logger.info("Listing chat history")
        chat_controller = get_chat_controller(request)
        return await chat_controller.list_threads(offset)
    except Exception as e:
        logger.exception("Exception occurred while listing chat history")
        return JSONResponse(status_code=500, content={"error": str(e)})


## USED
@chat_router.post("/history/read")
async def get_conversation(request: Request):
    try:
        logger.info("Fetching conversation")
        chat_controller = get_chat_controller(request)
        data = await request.json()
        thread_id = data.get("conversation_id")
        return await chat_controller.get_thread(thread_id)
    except Exception as e:
        logger.exception("Exception occurred while fetching conversation")
        return JSONResponse(status_code=500, content={"error": str(e)})


@chat_router.get("/history/execution_time")
async def get_execution_time(request: Request):
    try:
        logger.info("Fetching execution time")
        # Wait for 3 seconds before starting the generate task
        await asyncio.sleep(3)

        execution_time_controller = ExecutionTimeEstimate(request.state.user_id)
        user_id = request.state.user_id

        try:
            response_json = execution_time_controller.get_current_execution(
                user_id=user_id
            )
            logger.info("Execution time retrieved successfully")
        except Exception as e:
            logger.exception("Error retrieving execution time")
            # Handle exceptions that might occur during the execution time retrieval
            raise HTTPException(
                status_code=500, detail=f"Error retrieving execution time: {str(e)}"
            )

        return JSONResponse(content=response_json, status_code=200)

    except Exception as e:
        # Handle any other exceptions that might occur
        logger.exception("Unexpected error occurred while fetching execution time")
        raise HTTPException(status_code=500, detail=f"Unexpected error: {str(e)}")


## USED
@chat_router.post("/history/generate")
async def stream_chat_request(request: Request):
    try:
        logger.info("Generating chat request")
        user_id = request.state.user_id
        chat_controller = get_chat_controller(request)
        request_body = await request.json()
        data = await request.json()
        contract_workspace_id = data.get("contract_workspace_id")
        contract_workspace_list = data.get("contract_workspace_list", "")
        thread_id = data.get("conversation_id")
        messages = data.get("messages")
        user_input = messages[-1]["content"]
        history_metadata = request_body.get(
            "history_metadata", {"conversation_id": thread_id}
        )
        ai_mode = data.get("ai_mode", "standard")

        # For handling the Supplier Name question from chat UI for considering the synonyms
        specific_string = "What is the name of the supplier in this contract?"
        replacement_input = "Identify the name of the supplier specified in the contract. If the supplier name is not explicitly mentioned, search for synonyms such as provider, agency, contractor name or contractor lead company. Exclude Allianz or any of its subsidiaries as a potential supplier. Ensure complete accuracy in capturing the supplier name."
        if user_input == specific_string:
            user_input = replacement_input

        if not thread_id:
            title = await chat_controller.generate_title(message=user_input)
            thread = Thread(user_id=user_id, title=title)
            thread.save()

            thread_id = thread.id
            history_metadata["title"] = title
            history_metadata["date"] = thread.created_at
            history_metadata["conversation_id"] = thread_id

        user_message = Message(
            user_id=user_id,
            thread_id=thread_id,
            role=messages[-1]["role"],
            content=messages[-1]["content"],
            contract_id=messages[-1]["contract_id"],
        )
        user_message.save()

        message_id = user_message.id
        contract_workspace_list_val = ""

        # Check for multi-contract scenario
        if len(contract_workspace_list) > 1:
            logger.info(f"Handling multi-contract scenario conversation_id: {thread_id}, user_message_id: {message_id}")
            # Extract Ids and join them with a comma
            contract_workspace_list_val = ",".join(
                item["id"] for item in contract_workspace_list
            )

            # ✅ Variables to collect Phase 1 and Phase 2 data
            phase1_data = None
            phase2_data = None

            # Multi-contract flow
            async def generate_multi_contract():
                nonlocal phase1_data, phase2_data  # ← Access outer variables

                async for chunk in chat_controller.stream_multi_contract_chat_response(
                        conversation_id=thread_id,
                        message_history=messages,
                        input_message=user_input,
                        user_id=user_id,
                        contract_workspace=contract_workspace_list_val,
                        ai_mode=ai_mode,
                ):
                    # ============================================
                    # CHECK IF THIS IS A PHASE 2 CITATION UPDATE
                    # ============================================
                    if chunk.get("citation_update") == True:
                        logger.info("📥 Received Phase 2: Citation update from thread controller")
                        phase2_data = chunk  # ← Store Phase 2 data

                        # Phase 2: Pass through the citation update directly
                        chunk_data = {
                            "citation_update": True,
                            "citation_metadata": chunk.get("citation_metadata", {})
                        }

                        js_chunk = json.dumps(chunk_data, default=str) + "\n"
                        logger.info(f"📤 Yielding Phase 2 to frontend: {len(js_chunk)} bytes")
                        yield js_chunk
                        continue  # ⭐ Skip the rest - don't process as assistant message

                    # ============================================
                    # PHASE 1: BUILD ASSISTANT MESSAGE
                    # ============================================
                    logger.debug(f"📥 Received Phase 1 chunk with keys: {list(chunk.keys())}")
                    phase1_data = chunk  # ← Store Phase 1 data

                    # Extract citation metadata from chunk
                    citation_metadata = chunk.get("citation_metadata", None)

                    # Build assistant message
                    assistant_message = {
                        "role": "assistant",
                        "content": chunk["content"],
                        "contract_id": None,
                        "contract_workspace": "Multi-Contract",
                    }

                    # Add citation_metadata if available
                    if citation_metadata:
                        assistant_message["citation_metadata"] = citation_metadata
                        logger.info(
                            f"📤 Phase 1: Added citation metadata with "
                            f"{len(citation_metadata.get('citations', []))} citations "
                            f"(loading={citation_metadata.get('citation_loading', False)})"
                        )

                    # Add reasoning if available
                    if "reasoning" in chunk:
                        assistant_message["reasoning"] = chunk["reasoning"]

                    # Build response chunk
                    chunk_data = {
                        "id": message_id,
                        "choices": [
                            {
                                "messages": [assistant_message]
                            }
                        ],
                        "history_metadata": history_metadata,
                    }

                    js_chunk = json.dumps(chunk_data, default=str) + "\n"
                    yield js_chunk

            # ✅ Wrapper to save messages after streaming
            async def generate_multi_and_save():
                # Stream all chunks
                async for chunk in generate_multi_contract():
                    yield chunk

                # ✅ After streaming completes, save messages to database
                logger.info("🔄 Multi-contract streaming complete, saving messages to database...")

                try:
                    # Determine which citation metadata to use (prefer Phase 2)
                    citation_metadata = None
                    if phase2_data and "citation_metadata" in phase2_data:
                        citation_metadata = phase2_data["citation_metadata"]
                        logger.info("Using Phase 2 citation metadata for saving")
                    elif phase1_data and "citation_metadata" in phase1_data:
                        citation_metadata = phase1_data["citation_metadata"]
                        logger.info("Using Phase 1 citation metadata for saving")

                    # Save tool message with citations (multi-contract format)
                    if citation_metadata and "citations" in citation_metadata:
                        citations = citation_metadata.get("citations", [])
                        if citations:
                            tool_content = {
                                "citations": citations,
                                "multi_contract": True
                            }

                            tool_message = Message(
                                user_id=user_id,
                                thread_id=thread_id,
                                role="tool",
                                content=str(tool_content),
                                contract_id=None,  # Multi-contract has no single contract_id
                            )
                            tool_message.save()
                            logger.info(f"✅ Multi-contract tool message saved to DB ({len(citations)} citations)")
                        else:
                            logger.warning("⚠️ No citations in citation_metadata")
                    else:
                        logger.warning("⚠️ No tool message saved - citation_metadata missing or incomplete")

                    # Save assistant message
                    if phase1_data:
                        assistant_message = Message(
                            user_id=user_id,
                            thread_id=thread_id,
                            role="assistant",
                            content=phase1_data["content"],
                            contract_id=None,  # Multi-contract
                        )
                        assistant_message.save()
                        logger.info("✅ Multi-contract assistant message saved to DB")

                    logger.info("✅ All multi-contract messages saved to database successfully")

                except Exception as save_error:
                    logger.error(f"❌ Error saving multi-contract messages to database: {str(save_error)}")
                    import traceback
                    logger.error(traceback.format_exc())
                    # Don't raise - streaming already completed successfully

            return StreamingResponse(
                generate_multi_and_save(), media_type="application/json-lines"
            )

        # Single contract flow
        logger.info(f"Handling single-contract scenario conversation_id: {thread_id}, user_message_id: {message_id}")
        contract = Contract.get_by_contract_workspace_id_and_user_id(
            contract_workspace_id, user_id
        )
        if contract is None and (
            contract is not None and contract.index_id == request.state.index_id
        ):
            logger.error(
                "Contract doesn't exist or user is not allowed to get insights"
            )
            return JSONResponse(
                status_code=400,
                content=prepare_error_payload(
                    payload="Contract doesn't exist or you are not allowed get insights from it",
                    message="Error",
                ),
            )
        contract_workspace = contract.contract_workspace

        # ✅ Variables to collect Phase 1 and Phase 2 data
        phase1_data = None
        phase2_data = None

        async def generate():
            nonlocal phase1_data, phase2_data  # ← Access outer variables

            async for chunk in chat_controller.stream_chat_response(
                    conversation_id=thread_id,
                    message_history=messages,
                    input_message=user_input,
                    user_id=user_id,
                    contract_workspace=contract_workspace,
                    ai_mode=ai_mode,
            ):
                # ============================================
                # CHECK IF THIS IS A PHASE 2 CITATION UPDATE
                # ============================================
                if chunk.get("citation_update") == True:
                    logger.info("📥 Received Phase 2: Citation update from thread controller")
                    logger.debug(f"Phase 2 citation_metadata keys: {list(chunk.get('citation_metadata', {}).keys())}")
                    phase2_data = chunk  # ← Store Phase 2 data

                    # Phase 2: Pass through the citation update directly
                    chunk_data = {
                        "citation_update": True,
                        "citation_metadata": chunk.get("citation_metadata", {})
                    }

                    js_chunk = json.dumps(chunk_data, default=str) + "\n"
                    logger.info(f"📤 Yielding Phase 2 to frontend: {len(js_chunk)} bytes")
                    yield js_chunk
                    continue  # ⭐ Skip the rest of the loop - don't process as assistant message

                # ============================================
                # PHASE 1: BUILD ASSISTANT MESSAGE
                # ============================================
                logger.debug(f"📥 Received Phase 1 chunk with keys: {list(chunk.keys())}")
                phase1_data = chunk  # ← Store Phase 1 data

                # Extract citation metadata from chunk
                citation_metadata = chunk.get("citation_metadata", None)

                # Build assistant message
                assistant_message = {
                    "role": "assistant",
                    "content": chunk["content"],
                    "contract_id": contract_workspace_id,
                    "contract_workspace": re.sub(r'^UCW_\d+_', '', contract_workspace),
                }

                # Add citation_metadata if available (Standard/Enhanced modes)
                if citation_metadata:
                    assistant_message["citation_metadata"] = citation_metadata
                    logger.info(
                        f"📤 Phase 1: Added citation metadata "
                        f"(loading={citation_metadata.get('citation_loading', False)}, "
                        f"has_file_id={citation_metadata.get('file_id') is not None})"
                    )

                # Build response chunk
                chunk_data = {
                    "id": message_id,
                    "choices": [
                        {
                            "messages": [assistant_message]
                        }
                    ],
                    "history_metadata": history_metadata,
                }

                js_chunk = json.dumps(chunk_data, default=str) + "\n"
                yield js_chunk

        # ✅ Wrapper to save messages after streaming
        async def generate_and_save():
            # Stream all chunks
            async for chunk in generate():
                yield chunk

            # ✅ After streaming completes, save messages to database
            logger.info("🔄 Single-contract streaming complete, saving messages to database...")

            try:
                # Determine which citation metadata to use (prefer Phase 2)
                citation_metadata = None
                if phase2_data and "citation_metadata" in phase2_data:
                    citation_metadata = phase2_data["citation_metadata"]
                    logger.info("Using Phase 2 citation metadata for saving")
                elif phase1_data and "citation_metadata" in phase1_data:
                    citation_metadata = phase1_data["citation_metadata"]
                    logger.info("Using Phase 1 citation metadata for saving")

                # Save tool message if citation metadata exists
                if citation_metadata and citation_metadata.get("file_id") is not None:
                    tool_content = {
                        "file_id": citation_metadata["file_id"],
                        "page_number": citation_metadata.get("page_number"),
                        "file_name": citation_metadata.get("file_name", "Unknown"),
                    }

                    if "citation_text" in citation_metadata:
                        tool_content["citation_text"] = citation_metadata["citation_text"]

                    if "citation_position" in citation_metadata:
                        tool_content["citation_position"] = citation_metadata["citation_position"]
                        tool_content["method_used"] = citation_metadata.get("method_used", "unknown")

                    tool_message = Message(
                        user_id=user_id,
                        thread_id=thread_id,
                        role="tool",
                        content=str(tool_content),
                        contract_id=contract_workspace_id,
                    )
                    tool_message.save()
                    logger.info(f"✅ Tool message saved to DB (file_id={tool_content['file_id']})")
                else:
                    logger.warning("⚠️ No tool message saved - citation_metadata missing or incomplete")

                # Save assistant message
                if phase1_data:
                    assistant_message = Message(
                        user_id=user_id,
                        thread_id=thread_id,
                        role="assistant",
                        content=phase1_data["content"],
                        contract_id=contract_workspace_id,
                    )
                    assistant_message.save()
                    logger.info("✅ Assistant message saved to DB")

                logger.info("✅ All messages saved to database successfully")

            except Exception as save_error:
                logger.error(f"❌ Error saving messages to database: {str(save_error)}")
                import traceback
                logger.error(traceback.format_exc())
                # Don't raise - streaming already completed successfully

        return StreamingResponse(generate_and_save(), media_type="application/json-lines")

    except Exception as e:
        logger.exception("Exception occurred while streaming chat request")
        return JSONResponse(status_code=500, content={"error": str(e)})

## USED
@chat_router.post("/history/update")
async def update_conversation(request: Request):
    try:
        logger.info("Updating conversation")
        chat_controller = get_chat_controller(request)
        data = await request.json()
        thread_id = data.get("conversation_id")
        messages = data.get("messages")
        return await chat_controller.update_thread(messages, thread_id)
    except Exception as e:
        logger.exception("Exception occurred while updating conversation")
        return JSONResponse(status_code=500, content={"error": str(e)})


## AUTH
@auth_router.post("/refresh-token")
async def refresh_token(request: Request):
    try:
        logger.info("Refreshing access token")
        access_token = request.state.access_token
        access_token = refresh_access_token(access_token)
        return JSONResponse(status_code=200, content={"access_token": access_token})
    except CustomException as exc:
        logger.error(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while refreshing token")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@auth_router.get("/getAToken")
async def azure_oauth_redirect(request: Request):
    code = request.query_params.get("code")
    state = request.query_params.get("state")

    frontend_url_base = os.getenv("APP_BASE_URL", "")

    if not frontend_url_base:
        logger.error("APP_BASE_URL environment variable is not set.")
        return JSONResponse(
            status_code=500,
            content={"error": "Application misconfiguration: APP_BASE_URL is not set."},
        )

    if not code:
        return JSONResponse(
            status_code=400, content={"error": "Missing code in OAuth callback."}
        )

    params = f"?code={code}"
    if state:
        params += f"&state={state}"

    return RedirectResponse(f"{frontend_url_base}/{params}")


@auth_router.post("/getAToken")
async def get_token_using_azure_token(body: GetAToken):
    try:
        logger.info("Acquiring token using Azure authorization code")
        
        code = body.code
        redirect_uri = body.redirect_uri
        result = acquire_token_by_authorization_code(
            code,
            redirect_uri=redirect_uri,
        )
        if "error" in result:
            raise AuthException(payload=result)

        json_data = get_user_details_from_azure_token(
            result["token_type"], result["access_token"]
        )

        _email = json_data.get("mail", None) or json_data.get("userPrincipalName", None)
        if _email is None:
            raise AuthException(payload="No email id found for user")

        user = User.lookup(email=_email)

        if not user:
            logger.info(f"Creating new user: {_email}")
            user = User.create_user(
                first_name=json_data.get("givenName", _email) or _email,
                last_name=json_data.get("surname", _email) or _email,
                email=_email,
                password=DEFAULT_PASSWORD,
                role=DEFAULT_USER_ROLE,
                index=find_client_details_from_email_domain(_email),
                approved=True,
                verified=True,
                is_active=True,
                allow_mfa=False,
                allow_sso=True,
            )
        elif (
            user.is_active is not True
        ):  # Make sure the user set as active when he logs in after acount deletion
            logger.info(f"Reactivating user: {_email}")
            User.update_user(
                user_id=user.user_id, is_active=True, approved=False, verified=True
            )
        return JSONResponse(
            status_code=200, content={"access_token": create_access_token(user)}
        )
    except CustomException as exc:
        logger.error(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while acquiring token")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@auth_router.get("/identity", dependencies=[Depends(auth_check)])
async def get_user_identity(request: Request):
    try:
        logger.info("Fetching user identity")
        user_id = request.state.user_id
        user_obj = User.identify(user_id)
        if not user_obj:
            raise AuthException(payload="User not found")
        user = UserIdentitySchema().dump(user_obj)
        user["roles"] = user_obj.roles.split(",")
        return JSONResponse(status_code=200, content={"data": user})
    except CustomException as exc:
        logger.error(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while fetching user identity")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@contract_management_router.delete("/file")
async def delete_file(request: Request, file_id: int):
    try:
        logger.info(f"Deleting file with ID: {file_id}")
        c = get_contract_management_controller(request)
        response = c.delete_file(file_id)
        return JSONResponse(
            status_code=200, content=prepare_success_payload(payload=response)
        )
    except CustomException as exc:
        logger.error(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while deleting file")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@contract_management_router.post("/file")
async def upload_file(
    request: Request, contract_workspace_id: int, file: UploadFile = File(...)
):
    correlation_id = request.headers.get("x-request-id", str(uuid.uuid4()))
    try:
        logger.info(f"Uploading file to contract workspace ID: {contract_workspace_id}")
        c = get_contract_management_controller(request)
        response = c.upload_file(contract_workspace_id, file, correlation_id=correlation_id)
        return JSONResponse(
            status_code=200, content=prepare_success_payload(payload=response)
        )
    except CustomException as exc:
        logger.error(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while uploading file")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@contract_management_router.get("/download-file")
async def download_file(request: Request, file_id: int):
    try:
        logger.info(f"Downloading file with ID: {file_id}")
        c = get_contract_management_controller(request)
        data, message = c.download_file(file_id)
        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=data, message=message)
        )
    except CustomException as exc:
        logger.error(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while downloading file")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@contract_management_router.get("/files")
async def get_file_list(
    request: Request,
    contract_workspace_id: int,
    name: str = None,
    page_number: int = 1,
    page_size: int = 15,
):
    try:
        logger.info(
            f"Fetching file list for contract workspace ID: {contract_workspace_id}"
        )
        c = get_contract_management_controller(request)
        response, pagination = c.get_files(
            contract_workspace_id,
            file_name=name,
            page_number=page_number,
            page_size=page_size,
        )
        return JSONResponse(
            status_code=200,
            content=prepare_success_payload(data=response, pagination=pagination),
        )
    except CustomException as exc:
        logger.error(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while fetching file list")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )



@contract_management_router.get("/only_contracts")
async def get_only_contract_workspace_list(
    request: Request,
    name: Optional[str] = None,
    offset: Optional[int] = Query(0, description= "offset"),
    limit:  Optional[int] = Query(100, description="limit")
):
    try:
        logger.info("Fetching contract workspace list")
        c = get_contract_management_controller(request)

        response = c.get_contract_workspaces_only(
            contract_workspace_name=name,
            offset=offset,
            limit=limit
        )

        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=response)
        )
    except ValueError as ve:
        logger.error(f"Validation error: {str(ve)}")
        # Handle validation errors
        return JSONResponse(
            status_code=400, content=prepare_error_payload(message=str(ve))
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while fetching contract workspace list")

        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@contract_management_router.get("/contracts")
async def get_contract_workspace_list(
    request: Request,
    name: Optional[str] = None,
    order_by: Optional[str] = None,
    contract_types: Optional[str] = Query(
        None, description="Comma-separated list of contract types"
    ),
    sharing_type: Optional[str] = Query(
        None, description="Filter by sharing type: 'uploaded', 'shared', or 'all'"
    ),
    offset: Optional[int] = Query(0, description= "offset"),
    limit:  Optional[int] = Query(19, description="limit")
):
    try:
        logger.info("Fetching contract workspace list")
        # Validate parameters
        valid_order_by = ["name_asc", "name_desc", "date_asc", "date_desc"]
        if order_by and order_by not in valid_order_by:
            return JSONResponse(
                status_code=400,
                content=prepare_error_payload(
                    message=f"Invalid order_by parameter. Must be one of: {', '.join(valid_order_by)}"
                ),
            )

        valid_sharing_types = ["uploaded", "shared", "all"]
        if sharing_type and sharing_type not in valid_sharing_types:
            logger.warning(f"Invalid sharing_type parameter: {sharing_type}")
            return JSONResponse(
                status_code=400,
                content=prepare_error_payload(
                    message=f"Invalid sharing_type parameter. Must be one of: {', '.join(valid_sharing_types)}"
                ),
            )

        c = get_contract_management_controller(request)

        # Parse contract types from comma-separated string
        contract_type_list = contract_types.split(",") if contract_types else None

        response = c.get_contract_workspaces(
            contract_workspace_name=name,
            order_by=order_by,
            contract_types=contract_type_list,
            sharing_type=sharing_type,
            offset= offset,
            limit=limit
        )

        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=response)
        )
    except ValueError as ve:
        logger.error(f"Validation error: {str(ve)}")
        # Handle validation errors
        return JSONResponse(
            status_code=400, content=prepare_error_payload(message=str(ve))
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while fetching contract workspace list")

        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@contract_management_router.post("/contract")
async def create_contract_workspace(request: Request, body: ManualContractWorkspaceCreateReq):
    try:
        correlation_id = request.headers.get("x-request-id", str(uuid.uuid4()))
        logger.info("Creating contract workspace")
        c = get_contract_management_controller(request)
        data, message = c.create_contract_workspace(
            body.contract_workspace_name,
            body.comments,
            "Manual",
            body.templates,
            body.contract_type,
            correlation_id=correlation_id,
        )
        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=data, payload=message)
        )
    except CustomException as exc:
        logger.error(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while creating contract workspace")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@contract_management_router.put("/contract")
async def update_contract_details(request: Request, body: ContractWorkspaceUpdateReq):
    try:
        logger.info("Updating contract workspace details")
        c = get_contract_management_controller(request)
        response = c.update_contract_workspace_details(
            body.contract_workspace_id, body.comments, body.contract_type
        )
        return JSONResponse(
            status_code=200, content=prepare_success_payload(payload=response)
        )
    except CustomException as exc:
        logger.error(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while updating contract workspace details")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@contract_management_router.delete("/contract")
async def delete_contract_workspace(request: Request, contract_workspace_id: int):
    try:
        logger.info(f"Deleting contract workspace with ID: {contract_workspace_id}")
        c = get_contract_management_controller(request)
        delete_status = c.delete_contract_workspace(contract_workspace_id)
        if delete_status:
            response = "Contract workspace deleted"
            return JSONResponse(
                status_code=200, content=prepare_success_payload(payload=response)
            )
        else:
            response = "Contract workspace not deleted"
            return JSONResponse(
                status_code=500, content=prepare_error_payload(payload=response)
            )
    except CustomException as exc:
        logger.error(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while deleting contract workspace")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@attribute_management_router.get("/answers")
async def get_answers(
    request: Request,
    question_set: str = Query(
        ..., description="Type of submission - 'rate_card' or other"
    ),
    contract_workspace_id: int = Query(..., description="Contract workspace ID"),
    attrb_name: Optional[str] = Query(None, description="Filter on attribute name"),
    template: Optional[str] = Query(
        None, description="Filter by template IDs (comma-separated)"
    ),
):
    try:
        logger.info("Fetching contract answers")
        c = get_attrb_management_controller(request)
        # Convert template string to list of template IDs if provided
        template_ids = None
        if template:
            template_ids = [int(id.strip()) for id in template.split(",") if id.strip()]

        response = c.get_contract_answers(
            question_set, contract_workspace_id, attrb_name, template_ids
        )
        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=response)
        )
    except CustomException as exc:
        logger.warning(
            f"Custom exception occurred: {exc.message}", extra={"payload": exc.payload}
        )
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while fetching contract answers")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@attribute_management_router.post("/answers")
async def submit_answers(
    request: Request,
    body: SubmitFormData,
    question_set: str = Query(
        ..., description="Type of submission - 'rate_card' or other"
    ),
    contract_workspace_id: int = Query(..., description="Contract workspace ID"),
    add_row: Optional[bool] = Query(
        False, description="Add an additional row for rate card"
    ),
):
    """
    User can submit answers for either regular attributes or rate card data.
    URL format: /answers?question_set=...&contract_workspace_id=...
    """
    try:
        logger.info("Submitting answers")
        c = get_attrb_management_controller(request)
        response = await c.submit_user_answers(
            contract_workspace_id=contract_workspace_id,
            json_data=body.form_data,
            question_set=question_set,
            add_row=add_row,
        )
        return JSONResponse(
            status_code=200, content=prepare_success_payload(message=response)
        )
    except CustomException as exc:
        logger.warning(
            f"Custom exception occurred: {exc.message}", extra={"payload": exc.payload}
        )
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while submitting answers")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@attribute_management_router.delete("/answers")
async def delete_answers(
    request: Request,
    body: SubmitFormData,
    question_set: str = Query(
        ..., description="Type of deletion - 'rate_card' or other"
    ),
    contract_workspace_id: int = Query(..., description="Contract workspace ID"),
    delete_type: Optional[str] = Query(
        default=None, description="Type of delete operation - 'single' or 'reset'"
    ),
):
    """
    User can delete multiple user attribute values or rate card entries.
    URL format: /answers?question_set=...&contract_workspace_id=...
    """
    try:
        logger.info("Deleting answers")
        c = get_attrb_management_controller(request)
        response = await c.delete_user_answers(
            contract_workspace_id=contract_workspace_id,
            json_data=body.form_data,
            question_set=question_set,
            delete_type=delete_type,
        )
        return JSONResponse(
            status_code=200, content=prepare_success_payload(message=response)
        )
    except CustomException as exc:
        logger.warning(
            f"Custom exception occurred: {exc.message}", extra={"payload": exc.payload}
        )
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while deleting answers")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@attribute_management_router.get("/export-answers")
async def export_answers(
    request: Request,
    question_set: str = Query(
        ...,
        description="Type of submission - 'rate_card_attrb', 'its_rate_card_attrb', 'custom_template', or other",
    ),
    contract_ids: List[int] = Query(None, description="List of contract workspace IDs"),
    template_ids: List[int] = Query(None, description="List of template IDs"),
    file_name: Optional[str] = Query(
        None, description="Custom file name for the export"
    ),
):
    try:
        logger.info("Exporting answers")
        c = get_attrb_management_controller(request)
        if not contract_ids:
            raise CustomException(
                message="At least one contract ID is required",
                error_code=400,
                payload={"error": "missing_contract_ids"},
            )

        response, message = await c.export_contract_answers(
            question_set=question_set,
            contract_workspace_ids=contract_ids,
            template_ids=template_ids,
            custom_file_name=file_name,
        )

        return JSONResponse(
            status_code=200,
            content=prepare_success_payload(data=response, message=message),
        )
    except CustomException as exc:
        logger.warning(
            f"Custom exception occurred: {exc.message}", extra={"payload": exc.payload}
        )
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while exporting answers")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@contract_comparison_router.get("/getembedinfo")
def get_embed_info(request: Request):
    try:
        logger.info("Fetching embed information")
        user_id = request.state.user_id
        embed_info = EmbedService(user_id).get_embed_info()
        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=embed_info)
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while fetching embed information")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@user_router.get("/getattrbpageinfo")
async def get_attribute_page_info(request: Request):
    try:
        logger.info("Fetching attribute page information")
        user_id = request.state.user_id
        attribute_page_info = AttributePageService(user_id).get_attrb_page_info()
        return JSONResponse(
            status_code=200, content={"success": True, "data": attribute_page_info}
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while fetching attribute page information")
        return JSONResponse(
            status_code=500, content={"success": False, "error": message}
        )


@blob_router.get("/{blob_path:path}")
def serve_blob_content(blob_path: str):
    try:
        logger.info(f"Serving blob content for path: {blob_path}")
        parts = blob_path.split("/", 1)
        if len(parts) < 2:
            raise CustomException(
                payload="Invalid blob path. Expected format: 'container_name/file_path'"
            )
        container_name, file_path = parts
        # Prevent path traversal
        if ".." in file_path or file_path.startswith("/"):
            raise CustomException(payload="Invalid file path")
        storage = AzureStorageClient(container_name=container_name)
        blob_stream, headers = storage.serve_file(file_path)
        if blob_stream:
            return Response(
                content=blob_stream, media_type=headers["Content-Type"], headers=headers
            )
        else:
            raise CustomException(payload="Blob not found")
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.payload}")
        return JSONResponse(status_code=exc.error_code, content=exc.content)
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while serving blob content")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


class AddQuestionToPanelBody(BaseModel):
    question: str
    businessLogic: str
    instructions: Optional[str] = None
    knowledgeBase: Optional[str] = None
    knowledgeBaseReference: Optional[str] = None


@template_management_router.post("/custom-panel")
async def create_custom_panel(request: Request, body: CustomPanelCreateReq):
    try:
        logger.info("Creating custom panel")
        correlation_id = request.headers.get("x-request-id", str(uuid.uuid4()))
        c = get_custom_panel_management_controller(request)
        data, message = c.create_custom_panel(
            body.panel_name, body.panel_description, body.contract_id, body.questions, correlation_id=correlation_id
        )
        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=data, payload=message)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while creating custom panel")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@template_management_router.put("/custom-panel")
async def modify_custom_panel(request: Request, body: CustomPanelUpdateReq):
    try:
        logger.info("Modifying custom panel")
        c = get_custom_panel_management_controller(request)
        data, message = c.update_custom_panel(
            body.panel_id,
            body.panel_name,
            body.panel_description,
            body.contract_id,
            body.questions,
        )
        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=data, payload=message)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while modifying custom panel")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@template_management_router.delete("/custom-panel/{panel_id}/question/{question_id}")
async def delete_panel_question(request: Request, panel_id: int, question_id: int):
    try:
        logger.info(f"Deleting question {question_id} from panel {panel_id}")
        controller = get_custom_panel_management_controller(request)
        response = controller.delete_question_in_panel(panel_id, question_id)
        return JSONResponse(
            status_code=200, content=prepare_success_payload(payload=response)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while deleting panel question")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@template_management_router.get("/custom-panels")
async def get_custom_panels(
    request: Request, panel_name: str = None, order_by: str = None
):
    try:
        logger.info("Fetching custom panels")
        c = get_custom_panel_management_controller(request)
        panels = c.get_custom_panels(panel_name=panel_name, order_by=order_by)
        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=panels)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while fetching custom panels")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@template_management_router.get("/custom-panel-repository")
async def get_custom_panel_repository(request: Request):
    try:
        logger.info("Fetching custom panel repository")
        c = get_custom_panel_management_controller(request)
        # Fetch all repository records for given user department
        repositories = c.get_custom_panel_repositories()
        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=repositories)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while fetching custom panel repository")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@template_management_router.get("/workspace-panels/{contract_workspace_id}")
async def get_workspace_panels(
    request: Request,
    contract_workspace_id: int,
    panel_name: str = None,
    order_by: str = None,
):
    """
    Get all active custom panels associated with a specific contract workspace
    """
    try:
        logger.info(
            f"Fetching workspace panels for contract workspace ID: {contract_workspace_id}"
        )
        c = get_custom_panel_management_controller(request)
        panels = c.get_workspace_panels(
            contract_workspace_id=contract_workspace_id,
            panel_name=panel_name,
            order_by=order_by,
        )
        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=panels)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while fetching workspace panels")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@template_management_router.post("/custom-panel/{panel_id}/question")
async def add_question_to_panel(
    request: Request, panel_id: int, body: AddQuestionToPanelBody
):
    try:
        logger.info(f"Adding question to panel {panel_id}")
        c = get_custom_panel_management_controller(request)
        new_question = c.add_question_to_panel(
            panel_id,
            body.question,
            body.businessLogic,
            body.instructions,
            body.knowledgeBaseReference,
            body.knowledgeBase
        )
        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=new_question)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while adding question to panel")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )



@template_management_router.get("/custom-panel/{panel_id}/questions")
async def get_panel_questions(request: Request, panel_id: int):
    try:
        logger.info(f"Fetching questions for panel {panel_id}")
        c = get_custom_panel_management_controller(request)
        questions = c.get_panel_questions(panel_id)
        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=questions)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while fetching panel questions")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@ariba_management_router.get("/metadata-fetching/{documentId}/documents")
async def get_associated_documents(request: Request, documentId: str):
    try:
        logger.info(f"Fetching associated documents for document ID: {documentId}")
        c = get_ariba_management_controller(request)
        documents = await c.get_associated_documents(documentId)

        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=documents)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except HTTPException as exc:
        logger.error(f"HTTP exception occurred: {exc.detail}")
        # Handle HTTP-specific exceptions separately
        return JSONResponse(
            status_code=exc.status_code,
            content=prepare_error_payload(
                payload=str(exc.detail), message="HTTP Error"
            ),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while fetching associated documents")
        return JSONResponse(
            status_code=500,
            content=prepare_error_payload(payload=str(exc), message=message),
        )


@ariba_management_router.post("/submit-documents")
async def submit_selected_documents(request: Request, body: AribaContractWorkspaceCreateReq):
    try:
        correlation_id = request.headers.get("x-request-id", str(uuid.uuid4()))
        logger.info("Submitting selected documents")
        # Split the documentId string into a list of document IDs
        document_ids_list = body.document_ids.split(",")

        last_modified_dates_list = body.last_modified_dates.split(",")

        # Instantiate AribaManagement using the request object
        ariba_management = get_ariba_management_controller(request)

        user_id = request.state.user_id

        logger.info(f"Processing contract_ws_id: {body.contract_workspace_name}, document_ids: {document_ids_list}, user_id: {user_id}, correlation_id: {correlation_id}")

        # Call the new ingestion method
        await ariba_management.ingest_selected_documents(
            document_ids=document_ids_list,
            workspace_name=body.contract_workspace_name,
            ariba_contract_ws_name=body.ariba_contract_ws_name,
            comments=body.comments,
            user_id=user_id,
            template_list=body.templates,
            contract_type=body.contract_type,
            last_modified_dates=last_modified_dates_list,
            correlation_id=correlation_id
        )

        return JSONResponse(
            status_code=200,
            content={"success": True, "message": "Documents processed successfully"},
        )

    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while submitting selected documents")
        return JSONResponse(
            status_code=500, content={"success": False, "message": message}
        )


@template_management_router.get("/custom-panel/{panel_id}/export")
async def get_panel_export(request: Request, panel_id: int):
    try:
        logger.info(f"Exporting answers for panel {panel_id}")
        c = get_custom_panel_management_controller(request)
        response, message = await c.export_panel_answers(panel_id)
        return JSONResponse(
            status_code=200,
            content=prepare_success_payload(data=response, message=message),
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while exporting panel answers")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@template_management_router.get("/custom-panel/{panel_id}/contracts")
async def get_panel_contracts(request: Request, panel_id: int):
    try:
        logger.info(f"Fetching contracts for panel {panel_id}")
        c = get_custom_panel_management_controller(request)
        contracts = c.get_panel_contracts(panel_id)
        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=contracts)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while fetching panel contracts")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@template_management_router.put("/custom-panel/{panel_id}/question/{question_id}")
async def edit_question_in_panel(
    request: Request, panel_id: int, question_id: int, body: AddQuestionToPanelBody
):
    try:
        logger.info(f"Editing question {question_id} in panel {panel_id}")
        c = get_custom_panel_management_controller(request)
        updated_question = c.edit_question_in_panel(
            panel_id,
            question_id,
            body.question,
            body.businessLogic,
            body.instructions,
            body.knowledgeBaseReference,
            body.knowledgeBase
        )
        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=updated_question)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while editing question in panel")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@template_management_router.delete("/custom-panel/{panel_id}/contract/{contract_id}")
async def delete_panel_contract(request: Request, panel_id: int, contract_id: int):
    try:
        logger.info(f"Deleting contract {contract_id} from panel {panel_id}")
        controller = get_custom_panel_management_controller(request)
        response = controller.delete_contract_in_panel(panel_id, contract_id)
        return JSONResponse(
            status_code=200, content=prepare_success_payload(payload=response)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while deleting contract from panel")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@template_management_router.delete("/custom-panel/{panel_id}")
async def delete_custom_panel(request: Request, panel_id: int):
    try:
        logger.info(f"Deleting custom panel {panel_id}")
        controller = get_custom_panel_management_controller(request)
        response = controller.delete_custom_panel(panel_id)
        return JSONResponse(
            status_code=200, content=prepare_success_payload(payload=response)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while deleting custom panel")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@template_management_router.post("/custom-panel/{panel_id}/contract")
async def add_panel_contracts(request: Request, panel_id: int, body: dict):
    """
    Add or update contracts for a given panel.
    body: expects a dict with key 'contract_ids', e.g., {"contract_ids": [1,2,3]}
    """
    try:
        logger.info(f"Adding contracts to panel {panel_id}")
        controller = get_custom_panel_management_controller(request)
        contract_ids = body.get("contract_ids")
        response = controller.add_panel_contracts(panel_id, contract_ids=contract_ids)
        return JSONResponse(
            status_code=200, content=prepare_success_payload(payload=response)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while adding contracts to panel")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@template_management_router.get("/custom-panel/knowledge-bases")
async def get_associated_knowledge_bases(request: Request):
    try:
        logger.info("Fetching associated knowledge bases")
        c = get_custom_panel_management_controller(request)
        documents = c.get_knowledge_bases()
        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=documents)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except HTTPException as exc:
        logger.error(f"HTTP exception occurred: {exc.detail}")
        # Handle HTTP-specific exceptions separately
        return JSONResponse(
            status_code=exc.status_code,
            content=prepare_error_payload(
                payload=str(exc.detail), message="HTTP Error"
            ),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while fetching knowledge bases")
        return JSONResponse(
            status_code=500,
            content=prepare_error_payload(payload=message),
        )


@template_management_router.post("/custom-panel/generate-business-logic")
async def generate_business_logic(request: Request, body: dict):
    try:
        logger.info("Generating business logic")
        question = body.get("question")
        kbName = body.get("kbName")
        instructions = body.get("instructions")
        c = get_custom_panel_management_controller(request)
        business_logic_json = c.generate_business_logic(question, kbName, instructions)

        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=business_logic_json)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except HTTPException as exc:
        logger.error(f"HTTP exception occurred: {exc.detail}")
        # Handle HTTP-specific exceptions separately
        return JSONResponse(
            status_code=exc.status_code,
            content=prepare_error_payload(
                payload=str(exc.detail), message="HTTP Error"
            ),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while generating business logic")
        return JSONResponse(
            status_code=500,
            content=prepare_error_payload(payload=message),
        )


@template_management_router.delete("/custom-panel/{knowledge_base_id}/knowledge-base")
async def delete_knowledge_base(request: Request, knowledge_base_id: int):
    try:
        logger.info(f"Deleting knowledge base {knowledge_base_id}")
        controller = get_custom_panel_management_controller(request)
        response = controller.delete_knowledge_base(knowledge_base_id)
        return JSONResponse(
            status_code=200, content=prepare_success_payload(payload=response)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while deleting knowledge base")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@template_management_router.delete(
    "/custom-panel/{knowledge_base_doc_id}/knowledge-base-document"
)
async def delete_knowledge_base_document(request: Request, knowledge_base_doc_id: int):
    try:
        logger.info(f"Deleting knowledge base document {knowledge_base_doc_id}")
        controller = get_custom_panel_management_controller(request)
        response = controller.delete_knowledge_base_document(knowledge_base_doc_id)
        return JSONResponse(
            status_code=200, content=prepare_success_payload(payload=response)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while deleting knowledge base document")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@contract_management_router.post("/share")
async def share_contract(request: Request, body: dict):
    try:
        logger.info("Sharing contract")
        contract_id = body.get("contract_id")
        controller = get_contract_management_controller(request)
        response = controller.share_contract(contract_id=contract_id)
        # response = {"message": f"Contract {contract_id} shared successfully"}
        return JSONResponse(
            status_code=200, content=prepare_success_payload(payload=response)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\\n\\nTraceback:\\n{trace}"
        logger.exception("Exception occurred while sharing contract")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@contract_management_router.post("/unshare")
async def unshare_contract(request: Request, body: dict):
    try:
        logger.info("Unsharing contract")
        contract_id = body.get("contract_id")
        controller = get_contract_management_controller(request)
        response = controller.unshare_contract(contract_id=contract_id)
        # response = {"message": f"Contract {contract_id} unshared successfully"}
        return JSONResponse(
            status_code=200, content=prepare_success_payload(payload=response)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\\n\\nTraceback:\\n{trace}"
        logger.exception("Exception occurred while unsharing contract")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@template_management_router.post("/knowledge_base")
async def upload_file_to_knowledge_base(
    request: Request,
    knowledge_base_id: str = Query(..., description="Knowledge base ID"),
    file: UploadFile = File(...),
):
    try:
        logger.info(f"Uploading file to knowledge base {knowledge_base_id}")
        kb_id_int = int(knowledge_base_id)
        c = get_custom_panel_management_controller(request)
        response = c.upload_document_to_knowledge_base(kb_id_int, file)
        return JSONResponse(
            status_code=200, content=prepare_success_payload(payload=response)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except HTTPException as exc:
        logger.error(f"HTTP exception occurred: {exc.detail}")
        return JSONResponse(
            status_code=exc.status_code,
            content=prepare_error_payload(payload=exc.detail),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while uploading file to knowledge base")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@template_management_router.post("/custom-panel/knowledge-base")
async def create_knowledge_base(request: Request, body: KnowledgeBaseSchemaCreateReq):
    try:
        logger.info("Creating knowledge base")
        c = get_custom_panel_management_controller(request)
        data, message = c.create_knowledge_base(body.name, body.description)
        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=data, payload=message)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while creating knowledge base")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@template_management_router.put("/custom-panel/knowledge-base/{knowledge_base_id}")
async def update_knowledge_base(request: Request, knowledge_base_id: int, body: KnowledgeBaseSchemaUpdateReq):
    try:
        logger.info("Creating knowledge base")
        c = get_custom_panel_management_controller(request)
        # data = c.update_knowledge_base(body.id, body.name, body.description, body.status, body.share)
        logger.info(f"controller knowledge_base_id: {knowledge_base_id}, name: {body.name}, description: {body.description}, status: {body.status}, share: {body.share}")
        data = c.update_knowledge_base(
            kb_id=knowledge_base_id,
            kb_name=body.name,
            kb_description=body.description,
            status=body.status,
            share=body.share
        )
        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=data, message="Knowledge base updated successfully")
        )
    except HTTPException as http_exc:
        return JSONResponse(
            status_code=http_exc.status_code,
            content=prepare_error_payload(message=http_exc.detail),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while updating knowledge base")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@template_management_router.post("/custom-panel-repository/{template_id}/share")
async def share_panel(request: Request, template_id: int):
    try:
        logger.info(f"Sharing panel with template ID {template_id}")
        c = get_custom_panel_management_controller(request)
        data, message = c.share_panel(template_id)
        return JSONResponse(
            status_code=200, content=prepare_success_payload(data=data, payload=message)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while sharing panel")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@template_management_router.delete("/custom-panel-repository/{repository_id}")
async def delete_custom_panel_repository(request: Request, repository_id: int):
    try:
        logger.info(f"Deleting custom panel repository {repository_id}")
        controller = get_custom_panel_management_controller(request)
        response = controller.delete_custom_panel_repository(repository_id)
        return JSONResponse(
            status_code=200, content=prepare_success_payload(payload=response)
        )
    except CustomException as exc:
        logger.warning(f"Custom exception occurred: {exc.message}")
        return JSONResponse(
            status_code=exc.error_code,
            content=prepare_error_payload(payload=exc.payload, message=exc.message),
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while deleting custom panel repository")
        return JSONResponse(
            status_code=500, content=prepare_error_payload(payload=message)
        )


@user_router.get("/department_info")
async def get_user_email_and_department(request: Request):
    """
    Get user email and department name by user_id.
    """
    user_id = request.state.user_id
    session = User.get_session()
    try:
        logger.info(f"Fetching email and department for user ID {user_id}")
        user = session.query(User).filter_by(user_id=user_id).first()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        email = user.email
        # Only one department per user
        department = user.departments[0].name if user.departments else None

        return JSONResponse(
            status_code=200,
            content={"user_id": user_id, "email": email, "department_name": department},
        )
    except Exception as exc:
        trace = traceback.format_exc()
        message = f"{str(exc)}\n\nTraceback:\n{trace}"
        logger.exception("Exception occurred while fetching user email and department")
        return JSONResponse(
            status_code=500, content={"success": False, "error": message}
        )
    finally:
        session.close()


app.include_router(blob_router)
app.include_router(auth_router)
app.include_router(chat_router)
app.include_router(contract_management_router)
app.include_router(attribute_management_router)
app.include_router(generic_router)
app.include_router(generic_secured_router)
app.include_router(user_router)
app.include_router(contract_comparison_router)
app.include_router(template_management_router)
app.include_router(ariba_management_router)

if __name__ == "__main__":
    import uvicorn

    logger.info("Starting API service...")
    uvicorn.run(app, host="localhost", port=8000)
