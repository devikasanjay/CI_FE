from enum import Enum
import mimetypes
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from typing import Optional, List, Tuple
from sqlalchemy.sql.functions import count as sa_count, func
from sqlalchemy import literal
import sqlalchemy as sa
from components.models.auth import UserDepartment, User, UserCategory, ContractAccessManagement, ContractDepartment
from components.models.base import Base
from components.models.contract import Contract, ContractStatus
from components.models.file import File, FileUploadStatus
from components.models.ariba_upload_queue import AribaUploadQueue
from fastapi import UploadFile, Request
from services.storage import AzureStorageClient
from sqlalchemy import and_, or_, case
from utils.exceptions import CustomException
from marshmallow import Schema, fields
from pydantic import BaseModel
import time
import logging
import logging_config

logging_config.setup_logging()
logger = logging.getLogger(__name__)


class ContractSchema(Schema):
    contract_workspace = fields.Str()
    ariba_contract_ws_name = fields.Str()
    contract_id = fields.Int()
    status = fields.Str()
    comments = fields.Str()
    contract_type = fields.Str()
    created_at = fields.DateTime()
    updated_at = fields.DateTime()


class FileSchema(Schema):
    file_id = fields.Int()
    file_name = fields.Str()
    file_type = fields.Str()
    status = fields.Str()
    contract_workspace = fields.Str()
    created_at = fields.DateTime()
    updated_at = fields.DateTime()


class ManualContractWorkspaceCreateReq(BaseModel):
    contract_workspace_name: str
    comments: str
    templates: list = []
    contract_type: str = ""


class AribaContractWorkspaceCreateReq(ManualContractWorkspaceCreateReq):
    ariba_contract_ws_name: str
    document_ids: str = ""
    last_modified_dates: str = ""


class ContractWorkspaceUpdateReq(BaseModel):
    contract_workspace_id: int
    comments: str
    contract_type: str


class ContractWorkspaceCustomStatus(Enum):
    UPLOAD_IN_PROGRESS = 0
    EMPTY_WORKSPACE = 1
    UPLOADED = 2
    INGESTION_FAILED = 3
    INGESTED = 4
    ANALYSIS_FAILED = 5
    ANALYSED = 6


class ContractManagement:
    def __init__(self, user_id: int, index_name: str, index_id: int, access_token: str):
        self.index_name = index_name
        self.user_id = user_id
        self.index_id = index_id
        self.storage = AzureStorageClient(container_name=self.index_name)
        self.access_token = access_token
        self.max_workspace_name_length = 80

    def _add_workspace_prefix(self, contract_workspace_name):
        # Remove leading and trailing spaces from the contract_workspace_name
        trimmed_cw_name = contract_workspace_name.strip()
        return f"UCW_{self.user_id}_{trimmed_cw_name}"

    def _remove_workspace_prefix(self, contract_workspace_name):
        return re.sub(r'UCW_\d+_', '', contract_workspace_name)

    def _get_pagination(
        self, page_number: int, page_size: int, total_items: int, metadata: dict = {}
    ):
        metadata["page_number"] = page_number
        metadata["page_size"] = page_size
        metadata["total_pages"] = (total_items + page_size - 1) // page_size
        metadata["total_items"] = total_items
        return metadata

    def create_contract_workspace(
        self,
        contract_workspace_name: str,
        comments: str,
        source: str = None,
        templates: list | None = None,
        contract_type: str = "",
        correlation_id: str = None,
    ):
        templates = templates or []
        # Max allowed length is 90, but to give space for default prefix the restriction is set to 80
        if len(contract_workspace_name) > self.max_workspace_name_length:
            logger.warning(
                f"Workspace name exceeds max length: {contract_workspace_name}"
            )
            raise CustomException(
                payload=f"Workspace name should not exceed {self.max_workspace_name_length} characters"
            )

        logger.info(f"Creating Contract workspace: {contract_workspace_name}, correlation_id: {correlation_id}")

        updated_contract_workspace_name = self._add_workspace_prefix(
            contract_workspace_name
        )
        existing_workspace = Contract.fetch_contract(updated_contract_workspace_name)
        if existing_workspace and existing_workspace.user_id == self.user_id:
            logger.warning(
                f"Workspace name already exists: {updated_contract_workspace_name}"
            )
            raise CustomException(
                payload="Workspace name already exists. Try a different name"
            )
        contract_id = Contract.get_max_id() + 1
        contract = Contract(
            index_id=self.index_id,
            contract_workspace=updated_contract_workspace_name,
            user_id=self.user_id,
            comments=comments,
            source=source,
            contract_type=contract_type,
            correlation_id=correlation_id,
        )
        contract.contract_id = contract_id

        # --- Set ariba_contract_workspace according to your rule ---
        if source == 'CPI' and updated_contract_workspace_name:
            # Extract substring after last underscore
            ariba_workspace = updated_contract_workspace_name.rsplit('_', 1)[-1]
            contract.ariba_contract_workspace = ariba_workspace
        else:
            contract.ariba_contract_workspace = None

        contract.save()
        logger.info(f"Contract workspace created with ID: {contract_id}")
        if templates:
            logger.info(f"Adding templates to contract workspace: {templates}")
            # Add CustomContractPanelMapping entries for each template
            from components.models.custom_panel import (
                CustomContractPanelMapping,
                CustomPanel,
            )

            for template_id in templates:
                custom_panel_template_id = CustomContractPanelMapping.get_max_id() + 1
                CustomContractPanelMapping.add_custom_panel_contract(
                    contract_panel_id=custom_panel_template_id,
                    panel_id=template_id,
                    status="Not Ready",
                    contract_workspace=updated_contract_workspace_name,
                )
                CustomPanel.update_status(panel_id=template_id, status="New")
        return {"contract_workspace_id": contract_id}, "Contract workspace created"

    def delete_contract_workspace(self, contract_workspace_id: int):
        logger.info(f"Contract_workspace to delete for ID: {contract_workspace_id}")
        session = Base.get_session()
        try:
            # Fetch contract by ID only (not by user_id)
            contract = session.query(Contract).filter_by(
                contract_id=contract_workspace_id,
                index_id=self.index_id
            ).first()

            if contract is None:
                logger.warning(
                    f"Contract workspace not found for ID: {contract_workspace_id}"
                )
                raise CustomException(
                    payload="Contract doesn't exist"
                )

            # Check if user is CAM contract owner
            if contract.source == "CPI":
                if not self._is_cam_contract_owner(contract, session):
                    logger.warning(
                        f"User is not authorized to delete contract workspace ID: {contract_workspace_id}"
                    )
                    raise CustomException(
                        payload="You are not authorized to delete this contract. Only the contract owner can delete."
                    )

            # Delete all files in the workspace
            files = File.fetch_all_from_workspace(contract.contract_workspace)
            for file in files:
                self.delete_file(file.file_id)

            # Delete all associated records from ariba_upload_queue table
            ariba_delete_count = AribaUploadQueue.delete(contract_id=contract_workspace_id)
            if ariba_delete_count > 0:
                logger.info(
                    f"Deleted {ariba_delete_count} Ariba upload queue records for contract_id: {contract_workspace_id}")
            elif ariba_delete_count == 0:
                logger.info(f"No Ariba upload queue records found for contract_id: {contract_workspace_id}")
            else:
                logger.warning(
                    f"Error occurred while deleting Ariba upload queue records for contract_id: {contract_workspace_id}")

            # Delete all associated records from contract_department table
            contract_dept_delete_count = session.query(ContractDepartment) \
                .filter(ContractDepartment.contract_id == contract_workspace_id) \
                .delete()
            session.commit()

            if contract_dept_delete_count > 0:
                logger.info(
                    f"Deleted {contract_dept_delete_count} contract_department records for contract_id: {contract_workspace_id}")
            else:
                logger.info(f"No contract_department records found for contract_id: {contract_workspace_id}")

            # Now delete the contract
            contract_delete_status = contract.delete(contract_workspace_id)
            logger.info(f"Contract workspace deleted with ID: {contract_workspace_id} by contract owner")
            return contract_delete_status

        finally:
            session.close()

    def update_contract_workspace_details(
            self, contract_workspace_id: int, comments: str, contract_type: str
    ):
        logger.info(
            f"Contract_workspace_details to update for ID: {contract_workspace_id}"
        )
        session = Base.get_session()
        try:
            # Fetch contract by ID only (not by user_id)
            contract = session.query(Contract).filter_by(
                contract_id=contract_workspace_id,
                index_id=self.index_id
            ).first()

            if contract is None:
                logger.warning(
                    f"Contract workspace not found for ID: {contract_workspace_id}"
                )
                raise CustomException(
                    payload="Contract doesn't exist"
                )

            # Check if user is CAM contract owner
            if contract.source == "CPI":
                if not self._is_cam_contract_owner(contract, session):
                    logger.warning(
                        f"User is not authorized to update contract workspace ID: {contract_workspace_id}"
                    )
                    raise CustomException(
                        payload="You are not authorized to edit this contract. Only the contract owner from can edit."
                    )

            # Update contract details
            contract.comments = comments
            contract.contract_type = contract_type

            # Commit using the existing session
            session.commit()

            logger.info(
                f"Contract workspace details updated for ID: {contract_workspace_id} by contract owner"
            )
            return "Contract workspace details updated"

        except Exception as e:
            session.rollback()
            raise
        finally:
            session.close()

    # Cache for department info - will be invalidated after 5 minutes
    # Store the last time each user_id was fetched
    _last_fetch_time = {}

    def _get_user_departments(
        self, user_id: int, expiry_time: int
    ) -> List[Tuple[int, Optional[str]]]:
        """Get user departments with caching based on user_id and a time-based expiry"""
        logger.debug(f"Get_user_departments method for user_id: {user_id}")
        current_time = time.time()

        # Check if we have a recent result
        if user_id in self._last_fetch_time:
            last_time = self._last_fetch_time[user_id][0]
            if current_time - last_time < expiry_time:
                return self._last_fetch_time[user_id][1]  # Return cached result

        # If we get here, we need to fetch from database
        session = Base.get_session()
        try:
            logger.info(
                f"Fetching user departments from database for user_id: {user_id}"
            )
            user_departments = (
                session.query(UserDepartment).filter_by(user_id=user_id).all()
            )
            try:
                result = [
                    (ud.department_id, ud.department.name if ud.department else None)
                    for ud in user_departments
                ]
                # Store result with timestamp
                self._last_fetch_time[user_id] = (current_time, result)
                logger.info(f"User departments fetched for user_id: {user_id}")
                return result
            except Exception as e:
                logger.error(
                    f"Error processing user departments: {str(e)}", exc_info=True
                )
                return []  # Return empty list on error
        finally:
            session.close()


    def get_contract_workspaces_only(
            self,
            contract_workspace_name: str = None,
            limit: int = None,
            offset: int = None,
    ):
        session = Base.get_session()
        try:
            current_time = int(time.time())
            logger.info(f"Current time for cache invalidation: {current_time}")

            user_departments = self._get_user_departments(
                self.user_id, current_time // 300
            )
            logger.info(f"User departments retrieved: {user_departments}")

            user_department_ids = [dept_id for dept_id, _ in user_departments]
            user_email = session.query(User.email).filter_by(user_id=self.user_id).scalar()

            logger.info(f"Fetching all contracts for user: {self.user_id} and user_departments: {user_department_ids}")

            category_workspace_list = []
            oe_workspace_list = []

            logger.info(f"Fetching contracts for user: {self.user_id} and user_departments: {user_department_ids}")

            base_visibility = or_(
                Contract.user_id == self.user_id,
                and_(
                    ContractDepartment.department_id.isnot(None),
                    ContractDepartment.department_id.in_(user_department_ids)
                )
            )

            cpi_visibility = None
            if 15 in user_department_ids:
                cpi_visibility = and_(
                    Contract.source == "CPI",
                    Contract.status == "Validation_pending"
                )
                logger.info("CPI Visibility: Department 15 rule applied")

            elif user_email is not None:
                workspace_conditions = []

                category_oe_workspaces = (
                    session.query(ContractAccessManagement.contract_workspace, literal("category").label("type"))
                    .join(UserCategory, ContractAccessManagement.category == UserCategory.category)
                    .filter(UserCategory.category_lead == user_email)
                    .union(
                        session.query(ContractAccessManagement.contract_workspace, literal("oe").label("type"))
                        .filter(ContractAccessManagement.contract_owner == user_email)
                    )
                    .all()
                )

                for ws, ws_type in category_oe_workspaces:
                    if ws_type == "category":
                        category_workspace_list.append(ws)
                    else:
                        oe_workspace_list.append(ws)

                if category_workspace_list:
                    workspace_conditions.append(Contract.ariba_contract_workspace.in_(category_workspace_list))
                if oe_workspace_list:
                    workspace_conditions.append(Contract.ariba_contract_workspace.in_(oe_workspace_list))

                logger.info(
                    f"Category workspaces: {len(category_workspace_list)}, OE workspaces: {len(oe_workspace_list)}")

                if workspace_conditions:
                    cpi_visibility = and_(
                        Contract.source == "CPI",
                        Contract.status == "Validation_pending",
                        or_(*workspace_conditions)
                    )
                    logger.info("CPI Visibility: Category/OE rule applied")
                else:
                    logger.info("CPI Visibility: No category or OE workspaces found")

            # Base query with window function to pick one row per contract_id
            rn = func.row_number().over(
                partition_by=Contract.contract_id,
                order_by=Contract.contract_workspace.asc()
            ).label("rn")

            base_query = (
                session.query(
                    Contract.contract_workspace,
                    Contract.ariba_contract_ws_name,
                    Contract.contract_id,
                    rn
                )
                .outerjoin(User, Contract.user_id == User.user_id)
                .outerjoin(ContractDepartment, Contract.contract_id == ContractDepartment.contract_id)
                .filter(Contract.index_id == self.index_id)
            )

            # Apply visibility
            if cpi_visibility is not None:
                base_query = base_query.filter(or_(base_visibility, cpi_visibility))
                logger.info("Applied visibility: base_visibility OR cpi_visibility")
            else:
                base_query = base_query.filter(base_visibility)
                logger.info("Applied visibility: base_visibility only")

            # Apply name filter if provided
            if contract_workspace_name:
                logger.info(f"Applying contract workspace name filter: {contract_workspace_name}")
                base_query = base_query.filter(
                    Contract.contract_workspace.ilike(f"%{contract_workspace_name}%")
                )

            # Subquery selects 1 row per contract_id (rn = 1), based on contract_workspace order
            subq = base_query.subquery()

            # Final query ordered by contract_workspace
            query = (
                session.query(
                    subq.c.contract_workspace,
                    subq.c.ariba_contract_ws_name,
                    subq.c.contract_id
                )
                .filter(subq.c.rn == 1)
                .order_by(subq.c.contract_workspace.asc())
            )

            logger.info(f"Offset is {offset} and limit is {limit}")
            query = query.limit(limit).offset(offset)

            contracts_data = query.all()
            logger.info(f"Contracts data retrieved: {len(contracts_data)} records")

            processed_contracts = []
            for contract_workspace, ariba_contract_workspace, contract_id in contracts_data:
                display_name = self._remove_workspace_prefix(
                    contract_workspace
                )
                processed_contracts.append({
                    "contract_workspace": display_name,
                    "ariba_contract_ws_name": ariba_contract_workspace,
                    "contract_id": contract_id
                })

            logger.info("Contract workspaces processed successfully.")

            # Get total count for pagination metadata (optional but useful for frontend)
            count_query = (
                session.query(sa.func.count(sa.distinct(Contract.contract_id)))
                .outerjoin(ContractDepartment, Contract.contract_id == ContractDepartment.contract_id)
                .filter(Contract.index_id == self.index_id)
            )

            # Apply same visibility filters to count query
            if cpi_visibility is not None:
                count_query = count_query.filter(or_(base_visibility, cpi_visibility))
            else:
                count_query = count_query.filter(base_visibility)

            # Apply same filters to count query
            if contract_workspace_name:
                count_query = count_query.filter(
                    Contract.contract_workspace.ilike(f"%{contract_workspace_name}%")
                )
            if contract_types:
                count_query = count_query.filter(Contract.contract_type.in_(contract_types))
            if sharing_type:
                if sharing_type == "uploaded":
                    count_query = count_query.filter(Contract.user_id == self.user_id)
                elif sharing_type == "shared":
                    count_query = count_query.filter(
                        or_(
                            and_(
                                Contract.user_id != self.user_id,
                                ContractDepartment.department_id.isnot(None),
                                ContractDepartment.department_id.in_(user_department_ids),
                                ~Contract.ariba_contract_workspace.in_(
                                    oe_workspace_list) if oe_workspace_list else True,
                                ~Contract.ariba_contract_workspace.in_(
                                    category_workspace_list) if category_workspace_list else True
                            ),
                            and_(
                                Contract.user_id != self.user_id,
                                literal(15).in_(user_department_ids),
                                Contract.source == "CPI",
                                Contract.status != "Failed",
                                ~Contract.ariba_contract_workspace.in_(
                                    oe_workspace_list) if oe_workspace_list else True,
                                ~Contract.ariba_contract_workspace.in_(
                                    category_workspace_list) if category_workspace_list else True
                            )
                        )
                    )

            total_count = count_query.scalar()

            return {
                "contracts": processed_contracts,
                "limit": limit,
                "offset": offset,
                "has_more": (offset + len(processed_contracts)) < total_count
            }

        finally:
            session.close()


    def get_contract_workspaces(
            self,
            contract_workspace_name: str = None,
            order_by: str = None,
            contract_types: List[str] = None,
            sharing_type: str = None,
            limit: int = None,
            offset: int = None,
    ):
        session = Base.get_session()
        try:
            # Get the current timestamp for cache invalidation
            current_time = int(time.time())
            logger.info(f"Current time for cache invalidation: {current_time}")

            # Get user departments with caching (invalidates every 5 minutes)
            user_departments = self._get_user_departments(
                self.user_id, current_time // 300
            )
            logger.info(f"User departments retrieved: {user_departments}")

            user_department_ids = [dept_id for dept_id, _ in user_departments]

            # Get user email once
            user_info = session.query(User.user_id, User.email).filter_by(user_id=self.user_id).first()
            user_email = user_info.email if user_info else None

            logger.info(f"Fetching contracts for user: {self.user_id} and user_departments: {user_department_ids}")

            category_workspace_list = []
            oe_workspace_list = []

            # Define the shared status case expression
            shared_status_case = case(
                (
                    or_(
                        and_(
                            ContractDepartment.department_id.isnot(None),
                            ContractDepartment.department_id.in_(user_department_ids)
                        ),
                        and_(
                            literal(15).in_(user_department_ids),
                            Contract.source == "CPI",
                            Contract.status != "Failed",
                            Contract.user_id != self.user_id
                        )
                    ),
                    1
                ),
                else_=0
            ).label("shared")

            logger.info(f"User departments retrieved: {user_department_ids}")
            logger.info(f"User id retrieved: {self.user_id}")
            logger.info(f"User email retrieved: {user_email}")

            # Base visibility: contracts owned by user OR belong to any of the user's departments
            base_visibility = or_(
                Contract.user_id == self.user_id,
                and_(
                    ContractDepartment.department_id.isnot(None),
                    ContractDepartment.department_id.in_(user_department_ids)
                )
            )

            # CPI inclusion rule
            cpi_status = (Contract.status != "Failed")
            cpi_source = (Contract.source == "CPI")
            cpi_visibility = None

            if 15 in user_department_ids:
                cpi_visibility = and_(cpi_source, cpi_status)
                logger.info("CPI Visibility: Department 15 rule applied")
            elif user_email is not None:
                workspace_conditions = []

                # Get category and OE workspaces in a single query using UNION
                category_oe_workspaces = (
                    session.query(ContractAccessManagement.contract_workspace, literal("category").label("type"))
                    .join(UserCategory, ContractAccessManagement.category == UserCategory.category)
                    .filter(UserCategory.category_lead == user_email)
                    .union(
                        session.query(ContractAccessManagement.contract_workspace, literal("oe").label("type"))
                        .filter(ContractAccessManagement.contract_owner == user_email)
                    )
                    .all()
                )

                for ws, ws_type in category_oe_workspaces:
                    if ws_type == "category":
                        category_workspace_list.append(ws)
                    else:
                        oe_workspace_list.append(ws)

                if category_workspace_list:
                    workspace_conditions.append(Contract.ariba_contract_workspace.in_(category_workspace_list))
                if oe_workspace_list:
                    workspace_conditions.append(Contract.ariba_contract_workspace.in_(oe_workspace_list))

                logger.info(
                    f"Category workspaces: {len(category_workspace_list)}, OE workspaces: {len(oe_workspace_list)}")

                if workspace_conditions:
                    cpi_visibility = and_(
                        cpi_source,
                        cpi_status,
                        or_(*workspace_conditions)
                    )
                    logger.info("CPI Visibility: Category/OE rule applied")
                else:
                    logger.info("CPI Visibility: No category or OE workspaces found")

            # Subquery for shared_user_email
            shared_user_subquery = (
                session.query(
                    ContractDepartment.contract_id,
                    User.email.label("shared_user_email")
                )
                .join(User, ContractDepartment.shared_user_id == User.user_id)
                .filter(ContractDepartment.department_id.in_(user_department_ids))
                # IMPORTANT: PostgreSQL requires ORDER BY to start with the DISTINCT ON column
                .order_by(ContractDepartment.contract_id)
                .distinct(ContractDepartment.contract_id)
                .subquery()
            )

            # Build base query with joins
            query = (
                session.query(
                    Contract,
                    shared_status_case,
                    User.email.label("user_email"),
                    shared_user_subquery.c.shared_user_email
                )
                .outerjoin(User, Contract.user_id == User.user_id)
                .outerjoin(ContractDepartment, Contract.contract_id == ContractDepartment.contract_id)
                .outerjoin(shared_user_subquery, Contract.contract_id == shared_user_subquery.c.contract_id)
                .filter(Contract.index_id == self.index_id)
                .distinct(Contract.contract_id)
            )

            # Apply visibility
            if cpi_visibility is not None:
                query = query.filter(or_(base_visibility, cpi_visibility))
                logger.info("Applied visibility: base_visibility OR cpi_visibility")
            else:
                query = query.filter(base_visibility)
                logger.info("Applied visibility: base_visibility only")

            # Apply name filter if provided
            if contract_workspace_name:
                logger.info(f"Applying contract workspace name filter: {contract_workspace_name}")
                query = query.filter(
                    Contract.contract_workspace.ilike(f"%{contract_workspace_name}%")
                )

            # Apply contract type filter if provided
            if contract_types:
                logger.info(f"Applying contract types filter: {contract_types}")
                query = query.filter(Contract.contract_type.in_(contract_types))

            # Apply sharing type filter if provided
            if sharing_type:
                logger.info(f"Applying sharing type filter: {sharing_type}")
                if sharing_type == "uploaded":
                    query = query.filter(Contract.user_id == self.user_id)
                elif sharing_type == "shared":
                    query = query.filter(
                        or_(
                            and_(
                                Contract.user_id != self.user_id,
                                ContractDepartment.department_id.isnot(None),
                                ContractDepartment.department_id.in_(user_department_ids),
                                ~Contract.ariba_contract_workspace.in_(
                                    oe_workspace_list) if oe_workspace_list else True,
                                ~Contract.ariba_contract_workspace.in_(
                                    category_workspace_list) if category_workspace_list else True
                            ),
                            and_(
                                Contract.user_id != self.user_id,
                                literal(15).in_(user_department_ids),
                                Contract.source == "CPI",
                                Contract.status != "Failed",
                                ~Contract.ariba_contract_workspace.in_(
                                    oe_workspace_list) if oe_workspace_list else True,
                                ~Contract.ariba_contract_workspace.in_(
                                    category_workspace_list) if category_workspace_list else True
                            )
                        )
                    )

            # Apply sorting at database level
            order_by_clauses = []

            # Because we use distinct(Contract.contract_id) -> DISTINCT ON(contract_id),
            # PostgreSQL requires ORDER BY to start with Contract.contract_id.
            order_by_clauses.append(Contract.contract_id)

            if order_by:
                logger.debug(f"Applying sorting: {order_by}")
                if order_by == "name_asc":
                    order_by_clauses.append(Contract.contract_workspace.asc())
                elif order_by == "name_desc":
                    order_by_clauses.append(Contract.contract_workspace.desc())
                elif order_by == "date_asc":
                    order_by_clauses.append(Contract.created_at.asc())
                elif order_by == "date_desc":
                    order_by_clauses.append(Contract.created_at.desc())
                else:
                    # Fallback if an unexpected value is passed
                    order_by_clauses.append(Contract.created_at.desc())
            else:
                # Default sorting
                order_by_clauses.append(Contract.created_at.desc())

            query = query.order_by(*order_by_clauses)

            logger.info(f"Offset is {offset} and limit is {limit}")
            # Apply pagination
            query = query.limit(limit).offset(offset)

            # Execute query
            contracts_data = query.all()
            logger.info(f"Contracts data retrieved: {len(contracts_data)} records")

            # Process results
            processed_contracts = []

            # Batch fetch file counts for all workspaces
            contract_workspaces = [
                contract.contract_workspace for contract, _, _, _ in contracts_data
            ]
            file_counts = self._batch_get_file_counts(contract_workspaces)
            logger.info(f"File counts retrieved: {len(file_counts)}")

            # Batch fetch contract statuses
            contract_statuses = self._batch_get_contract_statuses(contract_workspaces)
            logger.debug(f"Contract statuses retrieved: {contract_statuses}")

            # Batch fetch file ingestion statuses
            file_ingestion_statuses = {}
            for workspace in contract_workspaces:
                status = File.get_consolidated_file_status_for_workspace(workspace)
                if status is not None:
                    file_ingestion_statuses[workspace] = status

            # Batch check ownership for all contracts
            contract_workspace_to_ariba = {
                contract.contract_workspace: contract.ariba_contract_workspace
                for contract, _, _, _ in contracts_data
            }

            ariba_workspaces = list(set(contract_workspace_to_ariba.values()))

            # Batch query for contract ownership
            ownership_data = {}
            if user_email and ariba_workspaces:
                ownership_results = (
                    session.query(
                        ContractAccessManagement.contract_workspace,
                        ContractAccessManagement.contract_owner,
                        UserCategory.category_lead
                    )
                    .outerjoin(UserCategory, ContractAccessManagement.category == UserCategory.category)
                    .filter(ContractAccessManagement.contract_workspace.in_(ariba_workspaces))
                    .all()
                )

                for ws, owner, lead in ownership_results:
                    if ws not in ownership_data:
                        ownership_data[ws] = {"is_owner": False, "is_lead": False}
                    if owner == user_email:
                        ownership_data[ws]["is_owner"] = True
                    if lead == user_email:
                        ownership_data[ws]["is_lead"] = True

            # Get the current user's department name (first one if multiple)
            user_department_name = next(
                (name for _, name in user_departments if name), None
            )

            for contract, shared_status, user_email_from_query, shared_user_email in contracts_data:
                # Determine ownership type
                ownership_type = "department"

                if contract.user_id == self.user_id:
                    ownership_type = "user"
                elif 15 in user_department_ids:
                    if contract.source == "CPI" and contract.status != "Failed":
                        ownership_type = "user"
                else:
                    ariba_ws = contract.ariba_contract_workspace
                    if ariba_ws in ownership_data:
                        if ownership_data[ariba_ws]["is_owner"] or ownership_data[ariba_ws]["is_lead"]:
                            ownership_type = "user"

                # Enhanced handling for shared_by_email
                shared_by_email = shared_user_email if shared_user_email else user_email_from_query

                # Convert contract to dict
                contract_dict = ContractSchema().dump(contract)
                contract_workspace = contract_dict["contract_workspace"]

                # Get the display name using the existing method
                display_name = self._remove_workspace_prefix(
                    contract_workspace
                )

                # Get file count from the batch results
                file_count = file_counts.get(contract_workspace, 0)

                # Get contract status info from batch results
                contract_info = contract_statuses.get(contract_workspace)

                if contract_info:
                    contract_status = contract_info.get("status")
                    contract_type = contract_info.get("contract_type")
                    contract_source = contract_info.get("source", "").replace(
                        "CPI", "Ariba"
                    )
                else:
                    contract_status = None
                    contract_type = None
                    contract_source = ""

                # Determine the status
                if file_count == 0:
                    status = ContractWorkspaceCustomStatus.EMPTY_WORKSPACE.name
                else:
                    status_mapping = {
                        ContractStatus.VALIDATION_PENDING.capitalized_name: ContractWorkspaceCustomStatus.ANALYSED.name,
                        ContractStatus.FAILED.capitalized_name: ContractWorkspaceCustomStatus.ANALYSIS_FAILED.name,
                    }

                    status = status_mapping.get(contract_dict["status"])

                    if status is None:
                        if (
                                contract_status
                                == ContractStatus.UPLOAD_IN_PROGRESS.capitalized_name
                        ):
                            status = (
                                ContractWorkspaceCustomStatus.UPLOAD_IN_PROGRESS.name
                            )
                        else:
                            # Use batched file ingestion status
                            file_ingestion_status = file_ingestion_statuses.get(contract_workspace)
                            if file_ingestion_status is not None:
                                status = (
                                    ContractWorkspaceCustomStatus.INGESTED.name
                                    if file_ingestion_status
                                    else ContractWorkspaceCustomStatus.INGESTION_FAILED.name
                                )

                    if status is None:
                        status = (
                            ContractWorkspaceCustomStatus.UPLOADED.name
                            if file_count != 0
                            else ContractWorkspaceCustomStatus.EMPTY_WORKSPACE.name
                        )

                # Build the response object
                contract_dict["shared"] = shared_status
                contract_dict["shared_by_email"] = shared_by_email
                contract_dict["status"] = status
                contract_dict["contract_type"] = contract_type
                contract_dict["contract_source"] = contract_source
                contract_dict["contract_workspace"] = display_name
                contract_dict["file_count"] = file_count
                contract_dict["ownership_type"] = ownership_type
                contract_dict["department_name"] = user_department_name
                contract_dict["created_at_timestamp"] = (
                    contract.created_at.timestamp() if contract.created_at else 0
                )

                processed_contracts.append(contract_dict)

            # Get total count for pagination metadata (optional but useful for frontend)
            count_query = (
                session.query(sa.func.count(sa.distinct(Contract.contract_id)))
                .outerjoin(ContractDepartment, Contract.contract_id == ContractDepartment.contract_id)
                .filter(Contract.index_id == self.index_id)
            )

            # Apply same visibility filters to count query
            if cpi_visibility is not None:
                count_query = count_query.filter(or_(base_visibility, cpi_visibility))
            else:
                count_query = count_query.filter(base_visibility)

            # Apply same filters to count query
            if contract_workspace_name:
                count_query = count_query.filter(
                    Contract.contract_workspace.ilike(f"%{contract_workspace_name}%")
                )
            if contract_types:
                count_query = count_query.filter(Contract.contract_type.in_(contract_types))
            if sharing_type:
                if sharing_type == "uploaded":
                    count_query = count_query.filter(Contract.user_id == self.user_id)
                elif sharing_type == "shared":
                    count_query = count_query.filter(
                        or_(
                            and_(
                                Contract.user_id != self.user_id,
                                ContractDepartment.department_id.isnot(None),
                                ContractDepartment.department_id.in_(user_department_ids),
                                ~Contract.ariba_contract_workspace.in_(
                                    oe_workspace_list) if oe_workspace_list else True,
                                ~Contract.ariba_contract_workspace.in_(
                                    category_workspace_list) if category_workspace_list else True
                            ),
                            and_(
                                Contract.user_id != self.user_id,
                                literal(15).in_(user_department_ids),
                                Contract.source == "CPI",
                                Contract.status != "Failed",
                                ~Contract.ariba_contract_workspace.in_(
                                    oe_workspace_list) if oe_workspace_list else True,
                                ~Contract.ariba_contract_workspace.in_(
                                    category_workspace_list) if category_workspace_list else True
                            )
                        )
                    )

            total_count = count_query.scalar()

            logger.info("Contract workspaces processed successfully.")
            return {
                "contracts": processed_contracts,
                "total_count": total_count,
                "limit": limit,
                "offset": offset,
                "has_more": (offset + len(processed_contracts)) < total_count
            }
        finally:
            session.close()

    def _batch_get_file_counts(self, contract_workspaces):
        """
        Batch fetch file counts for multiple workspaces in a single query

        Args:
            contract_workspaces: List of contract workspace names

        Returns:
            Dict mapping workspace names to their file counts
        """
        if not contract_workspaces:
            logger.info("No contract workspaces provided.")
            return {}

        session = Base.get_session()
        try:
            # Use a single query to get file counts for all workspaces
            stmt = (
                sa.select(
                    File.contract_workspace,
                    sa_count(File.file_id).label("file_count"),
                )
                .where(File.contract_workspace.in_(contract_workspaces))
                .group_by(File.contract_workspace)
            )

            counts = session.execute(stmt).all()
            logger.info(f"File counts retrieved: {counts}")

            # Convert to dictionary for easy lookup
            return {workspace: count for workspace, count in counts}
        finally:
            session.close()

    def _batch_get_contract_statuses(self, contract_workspaces):
        """Batch fetch contract status information for multiple workspaces

        Args:
            contract_workspaces: List of contract workspace names

        Returns:
            Dict mapping workspace names to their status information
        """
        if not contract_workspaces:
            logger.info("No contract workspaces provided.")
            return {}

        session = Base.get_session()
        try:
            # Query all contract info at once
            contracts = (
                session.query(Contract)
                .filter(Contract.contract_workspace.in_(contract_workspaces))
                .all()
            )
            logger.info(f"Contract statuses retrieved: {contracts}")
            # Create a mapping of workspace to contract info
            return {
                contract.contract_workspace: {
                    "status": contract.status,
                    "contract_type": contract.contract_type,
                    "source": contract.source,
                }
                for contract in contracts
            }
        finally:
            session.close()

    def _is_cam_contract_owner(self, contract, session) -> bool:
        """
        Check if the current user is the contract owner in ContractAccessManagement table
        OR if the user belongs to department_id 15.

        Args:
            contract: The Contract object to check authorization for
            session: SQLAlchemy session

        Returns:
            bool: True if user is CAM contract owner or in department 15, False otherwise
        """
        try:
            # Check 1: Is user in department 15?
            user_departments = self._get_user_departments(self.user_id, int(time.time()) // 300)
            user_department_ids = [dept_id for dept_id, _ in user_departments]

            if 15 in user_department_ids:
                logger.info(f"User {self.user_id} has access via department 15")
                return True

            # Check 2: Is user contract owner in CAM table?
            # Only check CAM for CPI contracts with ariba_contract_workspace
            if not contract.ariba_contract_workspace:
                logger.info(f"Contract {contract.contract_id} has no ariba_contract_workspace")
                return False

            user_email = session.query(User.email).filter_by(user_id=self.user_id).scalar()

            if not user_email:
                logger.warning(f"No email found for user_id: {self.user_id}")
                return False

            is_cam_owner = session.query(ContractAccessManagement.contract_workspace) \
                               .filter(ContractAccessManagement.contract_owner == user_email) \
                               .filter(ContractAccessManagement.contract_workspace == contract.ariba_contract_workspace) \
                               .scalar() is not None

            if is_cam_owner:
                logger.info(
                    f"User {user_email} is contract owner for workspace: {contract.ariba_contract_workspace}")
            else:
                logger.info(
                    f"User {user_email} is NOT contract owner for workspace: {contract.ariba_contract_workspace}")

            return is_cam_owner

        except Exception as e:
            logger.error(f"Error checking contract owner: {str(e)}", exc_info=True)
            return False

    def share_contract(self, contract_id: int):
        """
        Share a contract with the user's department.
        Only contract owner, category lead, or users with specific CPI visibility can share.

        Args:
            contract_id: The ID of the contract to share

        Returns:
            dict: A response message indicating success or error
        """
        session = Base.get_session()
        try:
            # Fetch the contract
            contract = session.query(Contract).filter_by(contract_id=contract_id).first()

            if not contract:
                raise CustomException(payload=f"Contract {contract_id} not found")

            # Get user email and departments
            user_email = session.query(User.email).filter_by(user_id=self.user_id).scalar()

            # Get user departments with caching (invalidates every 5 minutes)
            current_time = int(time.time())
            user_departments = self._get_user_departments(self.user_id, current_time // 300)
            user_department_ids = [dept_id for dept_id, _ in user_departments]

            logger.info(f"User {self.user_id} ({user_email}) attempting to share contract {contract_id}")
            logger.info(f"User departments: {user_department_ids}")
            logger.info(f"Contract source: {contract.source}, status: {contract.status}")

            # Special rule: Department 15 users CANNOT share CPI Validation_pending contracts
            cpi_status = (contract.status == "Validation_pending")
            cpi_source = (contract.source == "CPI")

            if cpi_source and cpi_status and 15 in user_department_ids:
                logger.warning(
                    f"User {self.user_id} in department 15 cannot share CPI Validation_pending contract {contract_id}"
                )
                raise CustomException(
                    payload="Department 15 users cannot share CPI Validation_pending contracts as they already have access by default."
                )

                # Check authorization
            is_authorized = False
            authorization_reason = None

            # Check 1: Is user the contract owner (by user_id)?
            if contract.user_id == self.user_id:
                is_authorized = True
                authorization_reason = "contract_owner"
                logger.info(f"User {self.user_id} is the contract owner")

            # Check 2: CPI visibility rules (only for CPI contracts with Validation_pending status)
            if not is_authorized:
                cpi_status = (contract.status == "Validation_pending")
                cpi_source = (contract.source == "CPI")

                if cpi_source and cpi_status:
                    logger.info("Contract is CPI with Validation_pending status. Checking CPI visibility rules.")

                    # Rule 2b: Category lead or contract owner for CPI contracts
                    if user_email is not None:
                        category_workspace_list = []

                        # Get category name where user is category lead
                        category_name = (
                            session.query(UserCategory.category)
                            .filter_by(category_lead=user_email)
                            .scalar()
                        )

                        if category_name:
                            # Find contracts by category
                            category_workspaces = (
                                session.query(ContractAccessManagement.contract_workspace)
                                .filter(ContractAccessManagement.category == category_name)
                                .all()
                            )
                            category_workspace_list = [ws[0] for ws in category_workspaces]

                        # Find contracts by OE using user_email (contract owner)
                        oe_workspaces = (
                            session.query(ContractAccessManagement.contract_workspace)
                            .filter(ContractAccessManagement.contract_owner == user_email)
                            .all()
                        )
                        oe_workspace_list = [ws[0] for ws in oe_workspaces]

                        # Check if current contract is in either list
                        if contract.ariba_contract_workspace in category_workspace_list:
                            is_authorized = True
                            authorization_reason = "cpi_category_lead"
                            logger.info(f"User {user_email} has CPI access via category lead")
                        elif contract.ariba_contract_workspace in oe_workspace_list:
                            is_authorized = True
                            authorization_reason = "cpi_contract_owner_cam"
                            logger.info(f"User {user_email} has CPI access via contract owner")

                else:
                    logger.info(
                        f"Contract is not CPI or not Validation_pending (source={contract.source}, status={contract.status}). Skipping CPI visibility checks.")

            # Authorization check
            if not is_authorized:
                logger.warning(
                    f"User {self.user_id} is not authorized to share contract {contract_id}"
                )
                raise CustomException(
                    payload="You are not authorized to share this contract. Only the contract owner or category lead can share."
                )

            logger.info(
                f"User {self.user_id} authorized to share contract {contract_id}. Reason: {authorization_reason}")

            # Get the user's department to share with
            # If user has multiple departments, use the first one
            if not user_department_ids:
                raise CustomException(
                    payload="You are not associated with any department. Cannot share contract."
                )

            target_department_id = user_department_ids[0]  # Use first department
            logger.info(f"Sharing contract {contract_id} with department {target_department_id}")

            # Check if already shared with this department
            existing_share = session.query(ContractDepartment).filter(
                ContractDepartment.contract_id == contract_id,
                ContractDepartment.department_id == target_department_id
            ).first()

            if existing_share:
                logger.info(f"Contract {contract_id} is already shared with department {target_department_id}")
                return {
                    "message": f"Contract {contract_id} is already shared with your department",
                    "contract_id": contract_id,
                    "department_id": target_department_id,
                    "already_shared": True
                }

            # Create new ContractDepartment entry
            new_share = ContractDepartment(
                shared_user_id = self.user_id,
                contract_id=contract_id,
                department_id=target_department_id
            )
            session.add(new_share)
            session.commit()

            logger.info(f"Contract {contract_id} shared successfully with department {target_department_id}")

            return {
                "message": f"Contract {contract_id} shared successfully with your department",
                "contract_id": contract_id,
                "department_id": target_department_id,
                "already_shared": False,
                "authorization_reason": authorization_reason
            }

        except CustomException:
            session.rollback()
            raise
        except Exception as e:
            session.rollback()
            error_message = f"Failed to share contract {contract_id}: {str(e)}"
            logger.error(error_message, exc_info=True)
            raise CustomException(payload=error_message)
        finally:
            session.close()


    def unshare_contract(self, contract_id: int, department_id: int = None):
        """
        Unshare a contract from a department by removing the ContractDepartment entry.
        Only contract owner, category lead, or users listed in ContractAccessManagement can unshare.

        Args:
            contract_id: The ID of the contract to unshare
            department_id: Optional. Specific department to unshare from.
                          If None, unshares from user's current department.

        Returns:
            dict: A response message indicating success or error
        """
        session = Base.get_session()
        try:
            # Fetch the contract
            contract = session.query(Contract).filter_by(contract_id=contract_id).first()

            if not contract:
                raise CustomException(payload=f"Contract {contract_id} not found")

            # Get user email and departments
            user_email = session.query(User.email).filter_by(user_id=self.user_id).scalar()

            # Get user departments with caching (invalidates every 5 minutes)
            current_time = int(time.time())
            user_departments = self._get_user_departments(self.user_id, current_time // 300)
            user_department_ids = [dept_id for dept_id, _ in user_departments]

            logger.info(f"User {self.user_id} ({user_email}) attempting to unshare contract {contract_id}")
            logger.info(f"User departments: {user_department_ids}")

            # Check authorization
            is_authorized = False
            authorization_reason = None

            # Check 1: Is user the contract owner (by user_id)?
            if contract.user_id == self.user_id:
                is_authorized = True
                authorization_reason = "contract_owner"
                logger.info(f"User {self.user_id} is the contract owner")

            # Check 2: CPI visibility rules (for CPI contracts with Validation_pending status)
            if not is_authorized:
                cpi_status = (contract.status == "Validation_pending")
                cpi_source = (contract.source == "CPI")

                # Rule 2a (Department 15 CPI Access) has been removed.

                # Rule 2b: Check ContractAccessManagement for category lead or contract owner
                if cpi_source and cpi_status and user_email is not None:
                    category_workspace_list = []
                    oe_workspace_list = []

                    # Get category name where user is category lead
                    category_name = (
                        session.query(UserCategory.category)
                        .filter_by(category_lead=user_email)
                        .scalar()
                    )

                    if category_name:
                        # Find contracts by category
                        category_workspaces = (
                            session.query(ContractAccessManagement.contract_workspace)
                            .filter(ContractAccessManagement.category == category_name)
                            .all()
                        )
                        category_workspace_list = [ws[0] for ws in category_workspaces]
                        logger.info(f"Category workspaces for '{category_name}': {category_workspace_list}")

                    # Find contracts by OE using user_email (contract owner)
                    oe_workspaces = (
                        session.query(ContractAccessManagement.contract_workspace)
                        .filter(ContractAccessManagement.contract_owner == user_email)
                        .all()
                    )
                    oe_workspace_list = [ws[0] for ws in oe_workspaces]
                    logger.info(f"OE workspaces for '{user_email}': {oe_workspace_list}")

                    # Check if current contract is in either list
                    if contract.ariba_contract_workspace in category_workspace_list:
                        is_authorized = True
                        authorization_reason = "cpi_category_lead"
                        logger.info(f"User {user_email} has CPI access via category lead")
                    elif contract.ariba_contract_workspace in oe_workspace_list:
                        is_authorized = True
                        authorization_reason = "cpi_contract_owner_cam"
                        logger.info(f"User {user_email} has CPI access via contract owner")

            # Authorization check
            if not is_authorized:
                logger.warning(
                    f"User {self.user_id} is not authorized to unshare contract {contract_id}"
                )
                raise CustomException(
                    payload="You are not authorized to unshare this contract. Only the contract owner or category lead can unshare."
                )

            logger.info(
                f"User {self.user_id} authorized to unshare contract {contract_id}. Reason: {authorization_reason}")

            # Determine which department to unshare from
            if department_id is None:
                # If no specific department provided, use user's first department
                if not user_department_ids:
                    raise CustomException(
                        payload="You are not associated with any department. Cannot unshare contract."
                    )
                target_department_id = user_department_ids[0]
            else:
                # Use the provided department_id
                target_department_id = department_id

            logger.info(f"Unsharing contract {contract_id} from department {target_department_id}")

            # Check if the contract is shared with this department
            existing_share = session.query(ContractDepartment).filter(
                ContractDepartment.contract_id == contract_id,
                ContractDepartment.department_id == target_department_id,
                ContractDepartment.shared_user_id == self.user_id
            ).first()

            if not existing_share:
                logger.info(f"Contract {contract_id} is not shared with department {target_department_id}")
                return {
                    "message": f"Contract {contract_id} is not shared with department {target_department_id}",
                    "contract_id": contract_id,
                    "department_id": target_department_id,
                    "was_shared": False
                }

            # Delete the ContractDepartment entry
            session.delete(existing_share)
            session.commit()

            logger.info(f"Contract {contract_id} unshared successfully from department {target_department_id}")

            return {
                "message": f"Contract {contract_id} unshared successfully from department {target_department_id}",
                "contract_id": contract_id,
                "department_id": target_department_id,
                "was_shared": True,
                "authorization_reason": authorization_reason
            }

        except CustomException:
            session.rollback()
            raise
        except Exception as e:
            session.rollback()
            error_message = f"Failed to unshare contract {contract_id}: {str(e)}"
            logger.error(error_message, exc_info=True)
            raise CustomException(payload=error_message)
        finally:
            session.close()

    def upload_file(self, contract_workspace_id: int, file: UploadFile, correlation_id: str = None):
        session = Base.get_session()
        temp_file_path = None
        try:
            logger.info(
                f"Upload file for contract_workspace_id: {contract_workspace_id}"
            )

            # Fetch contract by ID only (not by user_id)
            contract = session.query(Contract).filter_by(
                contract_id=contract_workspace_id,
                index_id=self.index_id
            ).first()

            if contract is None:
                logger.info(
                    f"Contract not found for upload: {contract_workspace_id}"
                )
                raise CustomException(
                    payload="Contract doesn't exist"
                )

            # Check if user is CAM contract owner
            if contract.source == "CPI":
                if not self._is_cam_contract_owner(contract, session):
                    logger.warning(
                        f"User {self.user_id} is not authorized to upload files to contract workspace ID: {contract_workspace_id}"
                    )
                    raise CustomException(
                        payload="You are not authorized to upload files to this contract. Only the contract owner from can upload files."
                    )

            file_name = file.filename
            logger.info(f"Uploading file: {file_name}")
            contract_workspace_name = contract.contract_workspace
            file_path = contract_workspace_name + "/" + file_name
            file_path_to_save_in_db = f"{self.index_name}/{file_path}"

            existing_file = File.get_file_by_file_path(file_path_to_save_in_db)

            temp_file_path = tempfile.NamedTemporaryFile(delete=False).name
            with open(temp_file_path, "wb") as buffer:
                shutil.copyfileobj(file.file, buffer)

            with open(temp_file_path, "rb") as data:
                mime_type = mimetypes.guess_type(temp_file_path)[0]
                if file_name.endswith(".pdf"):
                    mime_type = "application/pdf"
                if file_name.endswith(".txt"):
                    mime_type = "text/plain"
                if file_name.endswith(".ppt"):
                    mime_type = "application/vnd.ms-powerpoint"
                if file_name.endswith(".pptx"):
                    mime_type = "application/vnd.openxmlformats-officedocument.presentationml.presentation"

                contract_workspace_name = contract.contract_workspace
                self.storage.upload_file(data, file_path, content_type=mime_type)
                if existing_file is not None:
                    existing_file.status = FileUploadStatus.NEW.capitalized_name
                    existing_file.created_at = datetime.now(timezone.utc)
                    existing_file.updated_at = datetime.now(timezone.utc)
                    existing_file.import_flags = ""
                    existing_file.save()
                else:
                    f = File(
                        self.index_id,
                        file_name,
                        f"{self.index_name}/{file_path}",
                        user_id=self.user_id,
                        contract_workspace=contract_workspace_name,
                        correlation_id=correlation_id,
                    )
                    f.file_id = File.get_max_id() + 1
                    f.save()
                contract.status = ContractStatus.NEW.capitalized_name
                contract.import_flags = ""
                contract.correlation_id = correlation_id
                contract.save()
            logger.info(f"File uploaded successfully by contract owner: {file_name}")
            return "File uploaded"
        finally:
            if temp_file_path and os.path.exists(temp_file_path):
                os.remove(temp_file_path)
                logger.debug(f"Temporary file removed: {temp_file_path}")
            session.close()

    def delete_file(self, file_id: int):
        logger.debug(f"File to delete where file_id: {file_id}")
        session = Base.get_session()
        try:
            file = File.fetch_file_by_id(file_id)

            if not file:
                logger.warning(f"File not found for deletion: {file_id}")
                raise CustomException(payload="File doesn't exist")

            if file.index_id != self.index_id:
                logger.warning(f"File index mismatch for deletion: {file_id}")
                raise CustomException(payload="File doesn't exist")

            contract = Contract.fetch_contract(file.contract_workspace)

            if not contract:
                logger.warning(f"Contract not found for file: {file_id}")
                raise CustomException(payload="Associated contract doesn't exist")

            if contract.source == "CPI":
                if not self._is_cam_contract_owner(contract, session):
                    logger.warning(f"User {self.user_id} is not authorized to delete file ID: {file_id}")
                    raise CustomException(
                        payload="You are not authorized to delete this file. Only the contract owner from can delete files.")
                
            safe_to_delete_blob = File.check_if_safe_blob_delete(file_id)

            if safe_to_delete_blob:
                file_path = file.file_path.replace(f"{self.index_name}/", "")
                self.storage.delete_file(file_path)
                storage = AzureStorageClient("sections")
                storage.delete_folder(f"{str(file.file_id)}/")

            file.delete()

            contract.status = ContractStatus.NEW.capitalized_name
            contract.import_flags = ""
            contract.question_import_flags = ""
            contract.save()
            logger.info(f"File deleted successfully by CAM contract owner: {file_id}")
            return "File deleted"

        finally:
            session.close()

    def download_file(self, file_id: int):
        logger.debug(f"File to download where file_id: {file_id}")
        session = Base.get_session()
        try:
            file = File.fetch_file_by_id(file_id)

            if not file:
                logger.warning(f"File not found for download: {file_id}")
                raise CustomException(payload="File doesn't exist")

            if file.index_id != self.index_id:
                logger.warning(f"File index mismatch for download: {file_id}")
                raise CustomException(payload="File doesn't exist")

            contract = Contract.fetch_contract(file.contract_workspace)

            if not contract:
                logger.warning(f"Contract not found for file: {file_id}")
                raise CustomException(payload="Associated contract doesn't exist")

            # No authorization check - anyone who can view the contract can download
            file_path = file.file_path.replace(f"{self.index_name}/", "")
            message = "Download link generated successfully"
            logger.info(f"Download link generated for file_id: {file_id} by user {self.user_id}")
            return {"url": self.storage.generate_proxy_url(file_path, self.access_token)}, message

        finally:
            session.close()

    def get_shared_status(self, contract_id: int):
        logger.debug(f"Get shared_status for contract_id: {contract_id}")
        sharedStatus = Contract.get_shared_status(contract_id)
        if sharedStatus:
            logger.info(f"Shared status retrieved for contract_id: {contract_id}")
            return sharedStatus
        else:
            logger.info(f"No shared status found for contract_id: {contract_id}")
            return None

    def get_files(
        self,
        contract_workspace_id: int,
        file_name: str = None,
        page_number: int = 1,
        page_size: int = 15,
    ):
        try:
            logger.debug(f"Get_files of contract_workspace_id: {contract_workspace_id}")
            session = Base.get_session()
            contract = Contract.get_by_contract_workspace_id_and_user_id(
                contract_workspace_id, self.user_id
            )
            if contract is not None:
                logger.info(
                    f"Contract found for contract_workspace_id: {contract_workspace_id}"
                )
                # query = session.query(File).filter(File.index_id==self.index_id).filter(File.user_id==self.user_id).filter(File.contract_workspace==contract.contract_workspace)
                query = (
                    session.query(File)
                    .filter(File.index_id == self.index_id)
                    .filter(File.contract_workspace == contract.contract_workspace)
                )
                if file_name:
                    logger.debug(f"Applying file name filter: {file_name}")
                    query = query.filter(
                        File.file_name.icontains(file_name, autoescape=True)
                    )
                query = query.order_by(File.created_at.desc())
                total_items = query.count()
                query = query.limit(page_size).offset((page_number - 1) * page_size)
                pagination = self._get_pagination(page_number, page_size, total_items)
                files = query.all()
                result = []
                all_completed = True
                if len(files) > 0:
                    logger.info(
                        f"Files retrieved for contract_workspace_id: {contract_workspace_id}"
                    )
                    for file in files:
                        file = FileSchema().dump(file)
                        file["contract_workspace"] = self._remove_workspace_prefix(
                            file["contract_workspace"]
                        )
                        if (
                            file["status"]
                            != FileUploadStatus.COMPLETED.capitalized_name
                        ):
                            all_completed = False
                        result.append(file)
                return {"files": result, "all_completed": all_completed}, pagination
            else:
                logger.warning(
                    f"Contract not found or access denied for contract_workspace_id: {contract_workspace_id}"
                )
                raise CustomException(
                    payload="Contract doesn't exist or you are not allowed access it"
                )
        finally:
            session.close()


def get_contract_management_controller(request: Request):
    return ContractManagement(
        request.state.user_id,
        request.state.index_name,
        request.state.index_id,
        request.state.access_token,
    )
