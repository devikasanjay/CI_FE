import {
  useRef,
  useState,
  useEffect,
  useContext,
  useLayoutEffect,
} from "react";
import { IconButton, DialogType, Dialog } from "@fluentui/react";
import ReactMarkdown from "react-markdown";
import uuid from "react-uuid";
import { isEmpty } from "lodash";
import DOMPurify from "dompurify";

import styles from "./Chat.module.css";
import { XSSAllowTags } from "../../constants/xssAllowTags";

import {
  ChatMessage,
  ConversationRequest,
  Citation,
  ToolMessageContent,
  ChatResponse,
  historyGenerate,
  historyUpdate,
  ChatHistoryLoadingState,
  CosmosDBStatus,
  ErrorMessage,
  historyRead,
  historyList,
  getCitationData,
  History,
  historyDelete,
  getContractList,
  getEstimatedProcessingTime,
  messageStatus,
  getCitationBlobData,
  CitationMetadata,
  CitationPosition,
  getContractsForDropdowns,
} from "../../api";
import { Answer } from "../../components/Answer";
import { AppStateContext } from "../../state/AppProvider";
import { useBoolean } from "@fluentui/react-hooks";
import Grid from "@mui/material/Grid2";
import {
  Avatar,
  Box,
  Button,
  Divider,
  InputAdornment,
  List,
  ListItem,
  ListItemButton,
  TextField,
  Typography,
  MenuItem,
} from "@mui/material";
import HistoryIcon from "../../assets/images/HistoryIcon";
import { useTheme } from "@mui/material/styles";
import FrameIcon from "../../assets/images/FrameIcon";
import SendIcon from "../../assets/images/SendIcon";
import CancelIcon from "../../assets/images/close.svg";
import { historyPanelMockLists } from "../../constants/historyPanelMockList";
import { useDispatch, useSelector } from "react-redux";
import VectorIcon from "../../assets/images/VectorIcon";
import { hideLoader, showLoader } from "../../store/loaderSlice";
import { showSnackbar } from "../../store/snackBarSlice";
import { useLocation } from "react-router-dom";
import DeleteIcon from "../../assets/images/Delete.svg";
import { RootState } from "../../store/appStore";
import SearchableDropdown from "../../components/SearchableDropdown/SeachableDropdown";
import { MultiSelectSearchableDropdown } from "../../components/MultiSelectSearchableDropdown/MultiSelectSearchableDropdown";
import { ContractWorkspace } from "../../api";
import { NOUNCE } from "@utils/nonce";
import SimplePDFViewer from "../../components/Citations/SimplePDFViewer";
import AIModeDropdown, { AI_MODES } from "../../components/DropdownMenu/AIModeDropdown";
import CustomToggleButton from "@/src/components/inputs/CustomToggleButton/CustomToggleButton";

interface ExtendedCitation extends Citation {
  citation_text?: string;
  citation_position?: CitationPosition;
  file_name?: string;
}

const normalizeReasoning = (
  reasoning: string | string[] | null | undefined
): string[] | null => {
  if (!reasoning) return null;
  if (Array.isArray(reasoning)) return reasoning;
  return [reasoning];
};

const Chat = () => {
  const theme = useTheme();
  const inputRef = useRef<HTMLInputElement>(null);
  const location = useLocation();
  const dispatch = useDispatch();
  const appStateContext = useContext(AppStateContext);
  const ui = appStateContext?.state.frontendSettings?.ui;
  const AUTH_ENABLED = appStateContext?.state.frontendSettings?.auth_enabled;
  const chatMessageStreamEnd = useRef<HTMLDivElement | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [showLoadingMessage, setShowLoadingMessage] = useState<boolean>(false);
  const [activeCitation, setActiveCitation] = useState<ExtendedCitation>();
  const [activeCitationUrl, setActiveCitationUrl] = useState<string>();
  const [isCitationPanelOpen, setIsCitationPanelOpen] = useState<boolean>(false);
  const abortFuncs = useRef([] as AbortController[]);
  const [showAuthMessage, setShowAuthMessage] = useState<boolean | undefined>();
  const [convID, setConvId] = useState<string | null>("");
  const [historyListFilter, setHistoryListFilter] = useState<History[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [textMsg, setTextMsg] = useState<string>("");
  const [processMessages, setProcessMessages] = useState<messageStatus>(messageStatus.NotRunning,);
  const [clearingChat, setClearingChat] = useState<boolean>(false);
  const [hideErrorDialog, { toggle: toggleErrorDialog }] = useBoolean(true);
  const [errorMsg, setErrorMsg] = useState<ErrorMessage | null>();
  const [isHistoryPanelOpen, setIsHistoryPanelOpen] = useState<boolean>(false);
  const [selectedItem, setSelectedItem] = useState<string | null>("");
  const [fileDropdownData, setFileDropdownData] = useState<[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState(0);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeCitationBlob, setActiveCitationBlob] = useState<Blob | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState<ContractWorkspace[]>([]);
  const [processingTimeMsg, setProcessingTimeMsg] = useState<string>("");
  const [showProcessingTime, setShowProcessingTime] = useState(false);

  const [contractDropdownType, setContractDropdownType] = useState<"workspace_name" | "ariba_ws_name">("workspace_name");
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [workspaceAribaNameOpts, setWorkspaceAribaNameOpts] = useState<ContractWorkspace[]>([]);

  const [selectedMode, setSelectedMode] = useState<string>("standard");
  const [citationLoadingMessageId, setCitationLoadingMessageId] = useState<string | null>(null);

  const workspaceFromStore = useSelector(
    (state: RootState) => state.common?.workspacePayload,
  );

  const errorDialogContentProps = {
    type: DialogType.close,
    title: errorMsg?.title,
    closeButtonAriaLabel: "Close",
    subText: errorMsg?.subtitle,
  };

  const modalProps = {
    titleAriaId: "labelId",
    subtitleAriaId: "subTextId",
    isBlocking: true,
    styles: { main: { maxWidth: 450 } },
  };

  const [ASSISTANT, TOOL, ERROR] = ["assistant", "tool", "error"];
  const NO_CONTENT_ERROR = "No content in messages object.";

  useEffect(() => {
    if (
      appStateContext?.state.isCosmosDBAvailable?.status !==
      CosmosDBStatus.Working &&
      appStateContext?.state.isCosmosDBAvailable?.status !==
      CosmosDBStatus.NotConfigured &&
      appStateContext?.state.chatHistoryLoadingState() ===
      ChatHistoryLoadingState.Fail &&
      hideErrorDialog
    ) {
      const subtitle = `${appStateContext.state.isCosmosDBAvailable.status}. Please contact the site administrator.`;
      setErrorMsg({
        title: "Chat history is not enabled",
        subtitle: subtitle,
      });
      toggleErrorDialog();
    }
  }, [appStateContext?.state.isCosmosDBAvailable]);

  const handleErrorDialogClose = () => {
    toggleErrorDialog();
    setTimeout(() => {
      setErrorMsg(null);
    }, 500);
  };

  const handleModeChange = (mode: string) => {
    setSelectedMode(mode);
    setMessages([]);
    setTextMsg("");
    setConvId("");
    setSelectedItem(null);
    setIsCitationPanelOpen(false);
    setActiveCitation(undefined);
    setActiveCitationBlob(null);
    setShowProcessingTime(false);
    setProcessingTimeMsg("");

    appStateContext?.dispatch({
      type: "UPDATE_CURRENT_CHAT",
      payload: null,
    });
  };

  let assistantMessage = {} as ChatMessage;
  let toolMessage = {} as ChatMessage;
  let assistantContent = "";

  const processResultMessage = (
    resultMessage: ChatMessage,
    userMessage: ChatMessage,
    conversationId?: string,
  ) => {
    const generateUniqueId = () => {
      return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    };

    if (resultMessage.role === ASSISTANT) {
      assistantContent += resultMessage.content;
      assistantMessage = resultMessage;
      assistantMessage.content = assistantContent;

      if (!assistantMessage.id) {
        assistantMessage.id = generateUniqueId();
      }

      if (resultMessage.context) {
        toolMessage = {
          id: generateUniqueId(),
          role: TOOL,
          content: resultMessage.context,
          date: new Date().toISOString(),
          contract_id: resultMessage.contract_id,
          contract_workspace: resultMessage.contract_workspace,
        };
      }
    }

    if (resultMessage.role === TOOL) {
      toolMessage = resultMessage;
      if (!toolMessage.id) {
        toolMessage.id = generateUniqueId();
      }
    }

    if (!conversationId) {
      isEmpty(toolMessage)
        ? setMessages([...messages, userMessage, assistantMessage])
        : setMessages([
          ...messages,
          userMessage,
          toolMessage,
          assistantMessage,
        ]);
    } else {
      isEmpty(toolMessage)
        ? setMessages([...messages, assistantMessage])
        : setMessages([...messages, toolMessage, assistantMessage]);
    }
  };

  const makeApiRequestWithCosmosDB = async (
    question: string,
    conversationId?: string,
  ) => {
    setIsLoading(true);
    setShowLoadingMessage(true);
    if (selectedWorkspace.length > 1) {
      handleProcessingTimeMessage();
    }
    const abortController = new AbortController();
    abortFuncs.current.unshift(abortController);
    const userMessage: ChatMessage = {
      id: uuid(),
      role: "user",
      content: question,
      date: new Date().toISOString(),
      contract_id: selectedWorkspace[0].id,
      contract_workspace: selectedWorkspace[0].id,
    };

    let request: ConversationRequest;
    let conversation;
    if (conversationId) {
      conversation = appStateContext?.state?.currentChat;
      if (!conversation) {
        console.error("Conversation not found.");
        setIsLoading(false);
        setShowLoadingMessage(false);
        abortFuncs.current = abortFuncs.current.filter(
          (a) => a !== abortController,
        );
        return;
      } else {
        conversation.messages.push(userMessage);
        request = {
          messages: [
            ...conversation.messages.filter((answer) => answer.role !== ERROR),
          ],
          contract_workspaces: selectedWorkspace.length > 0
            ? selectedWorkspace.map((workspace) => workspace.id)
            : [],
        };
      }
    } else {
      request = {
        messages: [userMessage].filter((answer) => answer.role !== ERROR),
        contract_workspaces: selectedWorkspace.length > 0
          ? selectedWorkspace.map((workspace) => workspace.id)
          : [],
      };
      setMessages(request.messages);
    }
    let result = {} as ChatResponse;
    let errorResponseMessage = "Please try again. If the problem persists, please contact the site administrator.";
    try {
      const response = conversationId
        ? await historyGenerate(
          request,
          abortController.signal,
          selectedWorkspace[0].id,
          conversationId,
          selectedWorkspace,
          selectedMode
        )
        : await historyGenerate(
          request,
          abortController.signal,
          selectedWorkspace[0].id,
          undefined,
          selectedWorkspace,
          selectedMode
        );
      await fetchChatHistoryList();

      if (!response?.ok) {
        const responseJson = await response.json();
        errorResponseMessage =
          responseJson.error === undefined
            ? errorResponseMessage
            : parseErrorMessage(responseJson.error);
        const errorChatMsg: ChatMessage = {
          id: uuid(),
          role: ERROR,
          content: `There was an error generating a response. Chat history can't be saved at this time. ${errorResponseMessage}`,
          date: new Date().toISOString(),
          contract_id: selectedWorkspace[0].id,
          contract_workspace: selectedWorkspace[0].id,
        };
        let resultConversation;
        if (conversationId) {
          resultConversation = appStateContext?.state?.chatHistory?.find(
            (conv) => conv.id === conversationId,
          );
          if (!resultConversation) {
            console.error("Conversation not found.");
            setIsLoading(false);
            setShowLoadingMessage(false);
            abortFuncs.current = abortFuncs.current.filter(
              (a) => a !== abortController,
            );
            return;
          }
          resultConversation.messages.push(errorChatMsg);
        } else {
          setMessages([...messages, userMessage, errorChatMsg]);
          setIsLoading(false);
          setShowLoadingMessage(false);
          abortFuncs.current = abortFuncs.current.filter(
            (a) => a !== abortController,
          );
          return;
        }
        appStateContext?.dispatch({
          type: "UPDATE_CURRENT_CHAT",
          payload: resultConversation,
        });
        setMessages([...resultConversation.messages]);
        return;
      }
      if (response?.body) {
        const reader = response.body.getReader();

        let runningText = "";
        let assistantMessageId: string | null = null;

        while (true) {
          setProcessMessages(messageStatus.Processing);
          const { done, value } = await reader.read();
          if (done) break;

          const text = new TextDecoder("utf-8").decode(value);
          const objects = text.split("\n");

          objects.forEach((obj) => {
            try {
              if (obj !== "" && obj !== "{}") {
                runningText += obj;
                result = JSON.parse(runningText);

                if (result.citation_update === true) {
                  if (assistantMessageId) {
                    setMessages((prevMessages) => {
                      return prevMessages.map((msg) => {
                        if (msg.id === assistantMessageId && msg.role === "assistant") {
                          return {
                            ...msg,
                            citation_metadata: result.citation_metadata,
                          };
                        }
                        return msg;
                      });
                    });
                    setCitationLoadingMessageId(null);
                  }

                  runningText = "";
                  return;
                }

                if (!result.choices?.[0]?.messages?.[0].content) {
                  errorResponseMessage = NO_CONTENT_ERROR;
                  throw Error();
                }

                if (result.choices?.length > 0) {
                  result.choices[0].messages.forEach((msg, idx) => {
                    msg.id = `${result.id}-${msg.role}-${idx}-${Date.now()}`;
                    msg.date = new Date().toISOString();

                    if (msg.role === "assistant") {
                      assistantMessageId = msg.id;

                      if (msg.citation_metadata?.citation_loading === true && selectedMode !== "fast") {
                        setCitationLoadingMessageId(msg.id);
                      } else if (selectedMode === "fast") {
                        setCitationLoadingMessageId(null);
                      }
                    }

                    processResultMessage(msg, userMessage, conversationId);
                  });

                  if (result.choices[0].messages?.some((m) => m.role === ASSISTANT)) {
                    setShowLoadingMessage(false);
                  }
                }

                runningText = "";
                return;
              } else if (result.error) {
                throw Error(result.error);
              }
            } catch (e) {
              if (!(e instanceof SyntaxError)) {
                console.error(e);
                throw e;
              }
            }
          });
        }

        let resultConversation;
        if (conversationId) {
          resultConversation = appStateContext?.state?.currentChat;
          if (!resultConversation) {
            console.error("Conversation not found.");
            setIsLoading(false);
            setShowLoadingMessage(false);
            abortFuncs.current = abortFuncs.current.filter(
              (a) => a !== abortController,
            );
            return;
          }
          isEmpty(toolMessage)
            ? resultConversation.messages.push(assistantMessage)
            : resultConversation.messages.push(toolMessage, assistantMessage);
        } else {
          resultConversation = {
            id: result.history_metadata.conversation_id,
            title: result.history_metadata.title,
            messages: [userMessage],
            date: result.history_metadata.date,
          };
          isEmpty(toolMessage)
            ? resultConversation.messages.push(assistantMessage)
            : resultConversation.messages.push(toolMessage, assistantMessage);
        }
        if (!resultConversation) {
          setIsLoading(false);
          setShowLoadingMessage(false);
          abortFuncs.current = abortFuncs.current.filter(
            (a) => a !== abortController,
          );
          return;
        }
        appStateContext?.dispatch({
          type: "UPDATE_CURRENT_CHAT",
          payload: resultConversation,
        });
        isEmpty(toolMessage)
          ? setMessages([...messages, assistantMessage])
          : setMessages([...messages, toolMessage, assistantMessage]);

        console.groupEnd();
      }
    } catch (e) {
      if (result?.citation_update === true) {
        setIsLoading(false);
        setShowLoadingMessage(false);
        abortFuncs.current = abortFuncs.current.filter(
          (a) => a !== abortController,
        );
        setProcessMessages(messageStatus.Done);
        return abortController.abort();
      }

      if (!abortController.signal.aborted) {
        let errorMessage = `An error occurred. ${errorResponseMessage}`;
        if (result.error?.message) {
          errorMessage = result.error.message;
        } else if (typeof result.error === "string") {
          errorMessage = result.error;
        }

        errorMessage = parseErrorMessage(errorMessage);

        const errorChatMsg: ChatMessage = {
          id: uuid(),
          role: ERROR,
          content: errorMessage,
          date: new Date().toISOString(),
          contract_id: selectedWorkspace[0].id,
          contract_workspace: selectedWorkspace[0].id,
        };
        let resultConversation;
        if (conversationId) {
          resultConversation = appStateContext?.state?.chatHistory?.find(
            (conv) => conv.id === conversationId,
          );
          if (!resultConversation) {
            console.error("Conversation not found.");
            setIsLoading(false);
            setShowLoadingMessage(false);
            abortFuncs.current = abortFuncs.current.filter(
              (a) => a !== abortController,
            );
            return;
          }
          resultConversation.messages.push(errorChatMsg);
        } else {
          if (!result.history_metadata) {
            console.error("Error retrieving data.", result);
            const errorChatMsg: ChatMessage = {
              id: uuid(),
              role: ERROR,
              content: errorMessage,
              date: new Date().toISOString(),
              contract_id: selectedWorkspace[0].id,
              contract_workspace: selectedWorkspace[0].id,
            };
            setMessages([...messages, userMessage, errorChatMsg]);
            setIsLoading(false);
            setShowLoadingMessage(false);
            abortFuncs.current = abortFuncs.current.filter(
              (a) => a !== abortController,
            );
            return;
          }
          resultConversation = {
            id: result.history_metadata.conversation_id,
            title: result.history_metadata.title,
            messages: [userMessage],
            date: result.history_metadata.date,
          };
          resultConversation.messages.push(errorChatMsg);
        }
        if (!resultConversation) {
          setIsLoading(false);
          setShowLoadingMessage(false);
          abortFuncs.current = abortFuncs.current.filter(
            (a) => a !== abortController,
          );
          return;
        }
        appStateContext?.dispatch({
          type: "UPDATE_CURRENT_CHAT",
          payload: resultConversation,
        });
        setMessages([...messages, errorChatMsg]);
      } else {
        setMessages([...messages, userMessage]);
      }
    } finally {
      setIsLoading(false);
      setShowLoadingMessage(false);
      abortFuncs.current = abortFuncs.current.filter(
        (a) => a !== abortController,
      );
      setProcessMessages(messageStatus.Done);
    }
    return abortController.abort();
  };

  useEffect(() => {
    if (!isLoading && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isLoading]);

  const parseErrorMessage = (errorMessage: string) => {
    const errorCodeMessage = errorMessage.substring(
      0,
      errorMessage.indexOf("-") + 1,
    );
    const innerErrorCue = "{\\'error\\': {\\'message\\': ";
    if (errorMessage.includes(innerErrorCue)) {
      try {
        let innerErrorString = errorMessage.substring(
          errorMessage.indexOf(innerErrorCue),
        );
        if (innerErrorString.endsWith("'}}")) {
          innerErrorString = innerErrorString.substring(
            0,
            innerErrorString.length - 3,
          );
        }
        innerErrorString = innerErrorString.replaceAll("\\'", "'");
        const newErrorMessage = errorCodeMessage + " " + innerErrorString;
        errorMessage = newErrorMessage;
      } catch (e) {
        console.error("Error parsing inner error message: ", e);
      }
    }
    return errorMessage;
  };

  const newChat = () => {
    setProcessMessages(messageStatus.Processing);
    setMessages([]);
    setIsCitationPanelOpen(false);
    setActiveCitation(undefined);
    appStateContext?.dispatch({
      type: "UPDATE_CURRENT_CHAT",
      payload: null,
    });
    setProcessMessages(messageStatus.Done);
  };

  const stopGenerating = () => {
    abortFuncs.current.forEach((a) => a.abort());
    setShowLoadingMessage(false);
    setIsLoading(false);
  };

  useEffect(() => {
    const saveToDB = async (messages: ChatMessage[], id: string) => {
      const response = await historyUpdate(messages, id);
      return response;
    };

    if (
      appStateContext &&
      appStateContext.state.currentChat &&
      processMessages === messageStatus.Done
    ) {
      if (!appStateContext?.state.currentChat?.messages) {
        console.error("Failure fetching current chat state.");
        return;
      }
      const noContentError = appStateContext.state.currentChat.messages.find(
        (m) => m.role === ERROR,
      );

      if (!noContentError?.content.includes(NO_CONTENT_ERROR)) {
        saveToDB(
          appStateContext.state.currentChat.messages,
          appStateContext.state.currentChat.id,
        )
          .then((res) => {
            if (!res.ok) {
              const errorMessage =
                "An error occurred. Answers can't be saved at this time. If the problem persists, please contact the site administrator.";
              const errorChatMsg: ChatMessage = {
                id: uuid(),
                role: ERROR,
                content: errorMessage,
                date: new Date().toISOString(),
                contract_id: selectedWorkspace[0].id,
                contract_workspace: selectedWorkspace[0].id,
              };
              if (!appStateContext?.state.currentChat?.messages) {
                const err: Error = {
                  ...new Error(),
                  message: "Failure fetching current chat state.",
                };
                throw err;
              }
              setMessages([
                ...appStateContext?.state.currentChat?.messages,
                errorChatMsg,
              ]);
            }
            return res;
          })
          .catch((err) => {
            console.error("Error: ", err);
            const errRes: Response = {
              ...new Response(),
              ok: false,
              status: 500,
            };
            return errRes;
          });
      }
      appStateContext?.dispatch({
        type: "UPDATE_CHAT_HISTORY",
        payload: appStateContext.state.currentChat,
      });
      setMessages(appStateContext.state.currentChat.messages);
      setProcessMessages(messageStatus.NotRunning);
    }
  }, [processMessages]);

  useLayoutEffect(() => {
    chatMessageStreamEnd.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest"
    });
  }, [showLoadingMessage, processMessages]);

  const onShowCitation = async (citation: Citation) => {
    dispatch(showLoader());
    setActiveCitation(undefined);
    setActiveCitationBlob(null);
    setActiveCitationUrl(undefined);
    setIsCitationPanelOpen(false);
    await new Promise(resolve => setTimeout(resolve, 50));

    try {
      const result = await getCitationData(citation.file_id, citation.page);
      const citationBlob = await getCitationBlobData(result.citation_url);

      let newUrl;
      if (result?.citation_url?.length > 0) {
        newUrl = result?.citation_url;
      }

      const updatedCitation: ExtendedCitation = {
        ...citation,
        ...result,
        newUrl,
        citation_text: result.citation_text || citation.citation_text,
        citation_position: result.citation_position || citation.citation_position,
      };

      setActiveCitation(updatedCitation);
      setActiveCitationBlob(citationBlob);
      setIsCitationPanelOpen(true);
      setIsHistoryPanelOpen(false);
    } catch (error) {
      console.error("Error loading citation:", error);
      dispatch(
        showSnackbar({
          message: `Error loading citation: ${error instanceof Error ? error.message : 'Unknown error'}`,
          severity: "error",
        })
      );
    } finally {
      dispatch(hideLoader());
    }
  };

  useEffect(() => {
    let citationBlobUrl: string | undefined;

    const loadCitation = async () => {
      if (activeCitationBlob) {
        try {
          citationBlobUrl = URL.createObjectURL(activeCitationBlob);
          setActiveCitationUrl(citationBlobUrl);
        } catch (error) {
          console.error('Failed to create citation URL:', error);
        }
      }
    };

    loadCitation();

    return () => {
      if (citationBlobUrl) {
        URL.revokeObjectURL(citationBlobUrl);
      }
    };
  }, [activeCitationBlob]);

  const handleProcessingTimeMessage = async () => {
    try {
      const data = await getEstimatedProcessingTime();

      if (data) {
        let message = `Estimated processing time: ${data.estimated_processing_time} seconds.`;
        if (data.active_users_num > 0) {
          message += ` Currently ${data.active_users_num} user${data.active_users_num !== 1 ? "s" : ""} processing requests.`;
        }
        setShowProcessingTime(true);
        setProcessingTimeMsg(message);
      }
    } catch (error) {
      console.error("Error getting processing time:", error);
    }
  };

  useEffect(() => {
    if (!isLoading && showProcessingTime) {
      setShowProcessingTime(false);
      setProcessingTimeMsg("");
    }
  }, [isLoading, showProcessingTime]);

  const onViewSource = (citation: Citation) => {
    if (citation.url && !citation.url.includes("blob.core")) {
      window.open(citation.url, "_blank");
    }
  };

  const extractCitations = (message: ChatMessage): ExtendedCitation[] => {
    if (!message || !message.citation_metadata) {
      return [];
    }

    const metadata = message.citation_metadata;

    if (selectedMode === "fast" && metadata.citation_loading === true) {
      // proceed without waiting
    } else if (selectedMode !== "fast" && metadata.citation_loading === true) {
      return [];
    }

    if (metadata.citations && Array.isArray(metadata.citations)) {
      const citations: ExtendedCitation[] = metadata.citations
        .filter(item => {
          const isValid = item.file_id && item.page_number !== undefined;
          return isValid;
        })
        .map((item, index) => {
          const cleanContractName = item.contract_workspace
            ? item.contract_workspace.replace(/^UCW_\d+_/, '')
            : 'Unknown Contract';

          const citation: ExtendedCitation = {
            content: item.citation_text || '',
            id: `${item.file_id}-${item.page_number}-${index}`,
            title: `${cleanContractName} - ${item.file_name || 'Unknown file'} - Page ${item.page_number + 1}`,
            filepath: item.contract_workspace || '',
            url: '',
            metadata: null,
            chunk_id: `${item.file_id}-${item.page_number}`,
            reindex_id: null,
            reasoning: normalizeReasoning(item.reasoning),
            file_id: item.file_id.toString(),
            page: (item.page_number + 1).toString(),
            citation_url: [],
            addidtional_data: [],
            newUrl: '',
            contract_workspace: cleanContractName,
            file_name: item.file_name || 'Unknown file',
            file_type: item.file_type || 'pdf',
            citation_text: item.citation_text,
            citation_position: item.citation_position,
          };

          return citation;
        });

      return citations;
    }

    if (!metadata.file_id || metadata.page_number === undefined) {
      return [];
    }

    const contractWorkspace =
      message.contract_workspace ||
      (message as any).contract_workspace_list ||
      '';

    const citation: ExtendedCitation = {
      content: metadata.citation_text || '',
      id: `${metadata.file_id}-${metadata.page_number}`,
      title: `${metadata.file_name || 'Unknown file'} - Page ${metadata.page_number + 1}`,
      filepath: contractWorkspace,
      url: '',
      metadata: null,
      chunk_id: `${metadata.file_id}-${metadata.page_number}`,
      reindex_id: null,
      reasoning: normalizeReasoning(metadata.reasoning),
      file_id: metadata.file_id.toString(),
      page: (metadata.page_number + 1).toString(),
      citation_url: [],
      addidtional_data: [],
      newUrl: '',
      contract_workspace: contractWorkspace,
      file_name: metadata.file_name || 'Unknown file',
      file_type: 'pdf',
      citation_text: selectedMode === "fast" ? undefined : metadata.citation_text,
      citation_position: selectedMode === "fast" ? undefined : metadata.citation_position,
    };

    return [citation];
  };

  const disabledButton = () => {
    return (
      isLoading ||
      (messages && messages.length === 0) ||
      clearingChat ||
      appStateContext?.state.chatHistoryLoadingState() ===
      ChatHistoryLoadingState.Loading
    );
  };

  const handleSend = (question: string) => {
    if (question.length && selectedWorkspace.length > 0) {
      const conversationID = appStateContext?.state.currentChat?.id
        ? appStateContext?.state.currentChat?.id
        : convID
          ? convID
          : undefined;
      makeApiRequestWithCosmosDB(question, conversationID);
      setTextMsg("");
    }
  };
  const handleShowHistory = () => {
    setIsHistoryPanelOpen(!isHistoryPanelOpen);
    setIsCitationPanelOpen(false);
  };

  useEffect(() => {
    fetchChatHistoryList();
  }, []);

  const fetchChatHistoryList = async (
    offset = 0,
  ): Promise<History[] | null> => {
    const result = await historyList(offset)
      .then((response) => {
        if (response) {
          setHistoryListFilter(response);
        } else {
          setHistoryListFilter([]);
        }
        return response;
      })
      .catch((err) => {
        dispatch(
          showSnackbar({
            message: err,
            severity: "error",
          }),
        );
        return null;
      });
    return result;
  };
  useEffect(() => {
    return () => {
      setConvId("");
      appStateContext?.dispatch({
        type: "UPDATE_CURRENT_CHAT",
        payload: null,
      });
    };
  }, [location.pathname]);
  useEffect(() => {
    if (convID) {
      dispatch(showLoader());
      const convMessages = historyRead(convID)
        .then((res) => {
          appStateContext?.dispatch({
            type: "UPDATE_CHAT_HISTORY",
            payload: res,
          });
          appStateContext?.dispatch({
            type: "UPDATE_CURRENT_CHAT",
            payload: { id: convID, messages: res },
          });
          setMessages(res);
          return res;
        })
        .catch((err) => {
          setMessages([]);
          return [];
        })
        .finally(() => {
          dispatch(hideLoader());
        });
    }
    return () => {
      setConvId("");
      appStateContext?.dispatch({
        type: "UPDATE_CURRENT_CHAT",
        payload: null,
      });
    };
  }, [convID]);
  const fetchHistoryData = (event: React.MouseEvent) => {
    const target = event.currentTarget as HTMLElement;
    const data = target.getAttribute("data-value");
    setSelectedItem(data);
    setConvId(data);
  };

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const target = e.target as HTMLInputElement;
    setTextMsg(target.value);
  };
  const fireInitialQuestion = (question: string) => {
    setTextMsg(question);
  };
  const deleteHistory = async (historyId: string) => {
    dispatch(showLoader());
    if (
      (appStateContext?.state.currentChat?.id === historyId ||
        convID === historyId) &&
      appStateContext
    ) {
      appStateContext?.dispatch({
        type: "UPDATE_CURRENT_CHAT",
        payload: null,
      });
      setMessages([]);
      setConvId("");
    }
    await historyDelete(historyId);
    await fetchChatHistoryList();
    dispatch(hideLoader());
  };

  useEffect(() => {
    fetchWorkspaces();
  }, []);

  const handleWorkspaceChange = (selectedIds: string[]) => {
    if (!Array.isArray(selectedIds)) {
      console.error("Expected array of workspace IDs");
      return;
    }
    if (selectedIds.some((id) => typeof id !== "string")) {
      console.error("All workspace IDs must be strings");
      return;
    }

    const selectedWorkspace: ContractWorkspace[] = (
      Array.isArray(workspaces) ? workspaces : []
    ).filter(
      (workspace: ContractWorkspace) =>
        Array.isArray(selectedIds) && selectedIds.includes(workspace.id),
    );

    setSelectedWorkspace(selectedWorkspace || []);
  };

  const handleContractsDropdownChange = (value: any) => {
    setContractDropdownType(value);
  }

  const CONTRACT_PAGE_SIZE = 100;

  const handleContractSearch = async (
      searchTerm: string;
      offset: number
  ) => {
      return await getContractsForDropdowns(
          searchTerm,
          offset,
          CONTRACT_PAGE_SIZE
          );
      };

  const fetchWorkspaces = async () => {
    setLoading(true);
    setError(null);
    try {
      const contractsData =  await getContractsForDropdowns("");
      const analyzedContracts = contractsData?.data?.contracts;

      const contractsWSNameOpts = analyzedContracts?.map((contract: any) => ({
        id: contract.contract_id.toString() || "",
        label: contract.contract_workspace || "Unnamed Workspace",
      })) || [];
      setWorkspaces(contractsWSNameOpts);

      const contractsAribaNameOpts = analyzedContracts.map((contract: any) => ({
        id: contract.contract_id.toString(),
        label: contract.ariba_contract_ws_name || contract.contract_workspace || "Unnamed Workspace",
      }));
      setWorkspaceAribaNameOpts(contractsAribaNameOpts);

      if (contractsWSNameOpts.length > 0) {
        if ((workspaceFromStore as any).contract_id) {
          const payload: ContractWorkspace = {
            id: (workspaceFromStore as any).contract_id.toString() || "",
            label: (workspaceFromStore as any).contract_worspace,
          };
          setSelectedWorkspace([payload]);
        } else {
          setSelectedWorkspace(contractsWSNameOpts[0] || {});
        }
      }
    } catch (err) {
      setError("Failed to load workspaces");
    } finally {
      setLoading(false);
    }
  };

  // NEW: Server-side search helpers for dropdowns
  const searchWorkspacesByCWName = async (term: string): Promise<ContractWorkspace[]> => {
    try {
      const contractsData = await getContractsForDropdowns(term || "");
      const analyzedContracts = contractsData?.data?.contracts || [];
      return analyzedContracts.map((contract: any) => ({
        id: contract.contract_id?.toString() || "",
        label: contract.contract_workspace || "Unnamed Workspace",
      }));
    } catch (e) {
      console.error("searchWorkspacesByCWName error:", e);
      return [];
    }
  };

  const searchWorkspacesByAribaName = async (term: string): Promise<ContractWorkspace[]> => {
    try {
      const contractsData = await getContractsForDropdowns(term || "");
      const analyzedContracts = contractsData?.data?.contracts || [];
      return analyzedContracts.map((contract: any) => ({
        id: contract.contract_id?.toString() || "",
        label: contract.ariba_contract_ws_name || contract.contract_workspace || "Unnamed Workspace",
      }));
    } catch (e) {
      console.error("searchWorkspacesByAribaName error:", e);
      return [];
    }
  };

  return (
    <Grid container>
      <Grid
        sx={{
          flex: 1,
          mt: 8,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          background: "#fff",
          boxShadow: "0px 2px 4px rgba(0, 0, 0, 0.14), 0px 0px 2px rgba(0, 0, 0, 0.12)",
          borderRadius: "8px",
        }}
      >
        <Grid container sx={{ width: "100%" }} justifyContent="space-between">
          <Box sx={{ display: "flex" }}>
            <Typography
              align="center"
              sx={{ fontSize: "1.5rem", px: 2, p: 1.5 }}
            >
              Contract Insights - GenAI Chatbot
            </Typography>
          </Box>

          <Divider sx={{ width: "100%" }} />
          <Grid
            sx={{
              mt: 0.5,
              display: "flex",
              width: "100%",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <Box display="flex" alignItems="flex-start" sx={{
              flexDirection: "row",
              flexWrap: "nowrap",
              alignItems: 'center',
              gap: 1,
              px: 2, p: 1.5
            }}>
              <Typography variant="body1" sx={{ mr: 2 }}>
                Select Contract Workspace
              </Typography>
              <Box sx={{ width: "300px" }}>
                <MultiSelectSearchableDropdown
                  options={workspaces}
                  selectedValues={Array.isArray(selectedWorkspace)
                    ? selectedWorkspace.map((workspace) => workspace.id)
                    : []
                  }
                  onSelect={handleContractSearch}
                  placeholder="Contract Workspaces By Id"
                  selectionLimit={50}
                  onSearchRequest={searchWorkspacesByCWName}
                  debounceMs={400}
                />
              </Box>
              <Box sx={{ width: "300px" }}>
                <MultiSelectSearchableDropdown
                  options={workspaceAribaNameOpts}
                  selectedValues={Array.isArray(selectedWorkspace)
                    ? selectedWorkspace.map((workspace) => workspace.id)
                    : []
                  }
                  onSelect={handleContractSearch}
                  placeholder="Contract Workspaces By Name"
                  selectionLimit={50}
                  onSearchRequest={searchWorkspacesByAribaName}
                  debounceMs={400}
                />
              </Box>
            </Box>
            <Box display="flex" alignItems="center" gap="16px" sx={{ mr: 4 }}>
              <Typography variant="body1">AI Mode</Typography>
              <AIModeDropdown
                selectedMode={selectedMode}
                onModeChange={handleModeChange}
              />

              <Button
                sx={{ color: theme.palette.primary.main }}
                startIcon={<HistoryIcon />}
                onClick={handleShowHistory}
              >
                History
              </Button>
            </Box>
          </Grid>
        </Grid>
        <Divider sx={{ width: "100%" }} />

        <Grid
          justifyContent="center"
          alignItems="center"
          sx={{
            width: "100%",
            display: "flex",
            flexDirection: "row",
          }}
        >
          <Grid
            sx={{
              width: isCitationPanelOpen ? "45%" : "100%",
              transition: "width 0.3s ease",
              px: isCitationPanelOpen ? 0 : 20,
              height: "85vh",
              overflowY: "auto",
            }}
          >
            {!messages || messages.length < 1 ? (
              <Grid
                container
                direction="column"
                alignItems="center"
                className={styles.chatEmptyState}
              >
                <Box
                  component="div"
                  sx={{
                    color: theme.palette.primary.main,
                    pt: 3,
                  }}
                >
                  <FrameIcon />
                </Box>
                <Typography variant="body2" sx={{ my: 1 }}>
                  Please select a contract workspace and start asking questions.
                  Our Contract Intelligence tool is happy to assist you !
                </Typography>

                <Box
                  component="div"
                  sx={{
                    display: "flex",
                    gap: 2,
                    mt: 2,
                  }}
                >
                  <Box
                    sx={{
                      padding: "20px",
                      width: "450px",
                      textAlign: "center",
                      backgroundColor: theme.palette.grey[200],
                      borderRadius: 2,
                      fontSize: "0.875rem",
                      cursor: "pointer",
                    }}
                    onClick={() =>
                      fireInitialQuestion(
                        "What is the name of the supplier in this contract?",
                      )
                    }
                  >
                    "What is the name of the supplier in this contract?"
                  </Box>
                  <Box
                    sx={{
                      padding: "20px",
                      width: "450px",
                      textAlign: "center",
                      backgroundColor: theme.palette.grey[200],
                      borderRadius: 2,
                      fontSize: "0.875rem",
                      cursor: "pointer",
                    }}
                    onClick={() =>
                      fireInitialQuestion(
                        "What is the start date and end date of this contract?",
                      )
                    }
                  >
                    "What is the start date and end date of this contract?"
                  </Box>
                </Box>
              </Grid>
            ) : (
              <Box className={styles.chatMessageStream} role="log">
                {messages.map((answer, index) => (
                  <Box key={answer.id}>
                    {answer.role === "user" ? (
                      <Box
                        className={styles.chatMessageUser}
                        tabIndex={0}
                        sx={{ mb: 3 }}
                      >
                        <Box className={styles.chatMessageUserMessage}>
                          {answer.content}
                        </Box>
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            ml: 4,
                          }}
                        >
                          <Avatar
                            alt="Shubham Mishra"
                            sx={{
                              fontSize: "14px",
                              background: theme.palette.background.default,
                              border: `2px solid ${theme.palette.primary.main}`,
                              color: theme.palette.text.primary,
                            }}
                          ></Avatar>
                        </Box>
                      </Box>
                    ) : answer.role === "assistant" ? (
                      <Box
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          mb: 2,
                          position: "relative",
                        }}
                      >
                        <Box
                          sx={{
                            color: theme.palette.primary.main,
                            display: "flex",
                            alignItems: "center",
                            mr: 3,
                          }}
                        >
                          <VectorIcon />
                        </Box>

                        <Box
                          sx={{
                            border: `1px solid ${theme.palette.secondary.main}`,
                            borderRadius: 3,
                            flexGrow: 1,
                            position: "relative",
                          }}
                        >
                          {(() => {
                            const citations = extractCitations(answer);
                            const isCitationLoading = selectedMode === "fast"
                              ? false
                              : (answer.citation_metadata?.citation_loading === true);

                            return (
                              <Answer
                                answer={{
                                  answer: answer.content,
                                  citations: citations,
                                  message_id: answer.id,
                                  feedback: answer.feedback,
                                  reasoning: normalizeReasoning(answer.citation_metadata?.reasoning || answer.reasoning),
                                }}
                                citationLoading={isCitationLoading}
                                onCitationClicked={(c) => {
                                  onShowCitation(c);
                                }}
                              />
                            );
                          })()}
                        </Box>
                        <Box
                          sx={{
                            position: "absolute",
                            bottom: "-21px",
                            right: 8,
                            padding: "4px 8px",
                            borderRadius: "4px",
                            fontSize: "0.75rem",
                          }}
                        >
                          This content has been generated by AI
                        </Box>
                      </Box>
                    ) : answer.role === "error" ? (
                      <Box
                        className={styles.chatMessageError}
                        sx={{ ml: "52px" }}
                      >
                        <Grid
                          container
                          alignItems="center"
                          className={styles.chatMessageErrorContent}
                        >
                          <span>Error</span>
                        </Grid>
                        <span className={styles.chatMessageErrorContent}>
                          {answer.content}
                        </span>
                      </Box>
                    ) : null}
                  </Box>
                ))}
                {showLoadingMessage && (
                  <Box className={styles.chatMessageGpt}>
                    <Answer
                      answer={{
                        answer: "Thinking answer...",
                        citations: [],
                      }}
                      processingTimeMsg={processingTimeMsg}
                      onCitationClicked={() => null}
                    />
                    <div style={{ display: "none" }}>
                      showProcessingTime: {String(showProcessingTime)},
                      workspaceLength: {selectedWorkspace.length}, msg:{" "}
                      {processingTimeMsg}
                    </div>
                  </Box>
                )}
                <div ref={chatMessageStreamEnd} />
              </Box>
            )}
            <Grid
              container
              alignItems="center"
              className={styles.chatInput}
              sx={{
                position: "relative",
                bottom: 0,
                backgroundColor: theme.palette.background.default,
                zIndex: 10,
                pt: 2,
                pb: 2,
              }}
            >
              <Dialog
                hidden={hideErrorDialog}
                onDismiss={handleErrorDialogClose}
                aria-labelledby="error-dialog-title"
                aria-describedby="error-dialog-description"
              >
              </Dialog>
              <Box
                component="div"
                sx={{
                  width: "100%",
                  pb: 0,
                  pt: 0,
                }}
              >
                <TextField
                  inputRef={inputRef}
                  variant="outlined"
                  fullWidth
                  placeholder="Type a new question..."
                  value={textMsg}
                  slotProps={{
                    input: {
                      endAdornment: (
                        <InputAdornment
                          sx={{
                            color: theme.palette.primary.main,
                            cursor: "pointer",
                          }}
                          onClick={() => handleSend(textMsg)}
                          position="end"
                        >
                          <SendIcon />
                        </InputAdornment>
                      ),
                    },
                  }}
                  onInput={handleInput}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isLoading) {
                      handleSend(textMsg);
                    }
                  }}
                />
              </Box>
            </Grid>
          </Grid>

          {messages && messages.length > 0 && isCitationPanelOpen && activeCitation && (
            <Grid
              sx={{
                width: "55%",
                transition: "width 0.3s ease",
                borderLeft: `1px solid ${theme.palette.divider}`,
                boxShadow: "0px 2px 10px rgba(0, 0, 0, 0.1)",
                padding: "20px",
                backgroundColor: "#F5F5F5",
                borderRadius: 5,
                display: 'flex',
                flexDirection: 'column',
                height: '85vh',
                overflow: 'hidden',
              }}
              className={styles.citationPanel}
              tabIndex={0}
              role="tabpanel"
              aria-label="Citations Panel"
            >
              <Grid
                container
                justifyContent="space-between"
                alignItems="center"
                className={styles.citationPanelHeaderContainer}
                sx={{
                  borderBottom: `1px solid ${theme.palette.divider}`,
                  paddingBottom: "10px",
                  marginBottom: "20px",
                  flexShrink: 0,
                }}
              >
                <Typography
                  variant="h6"
                  className={styles.citationPanelHeader}
                  sx={{
                    fontWeight: "bold",
                    color: "#333",
                  }}
                >
                  Citations
                </Typography>
                <IconButton
                  aria-label="Close citations panel"
                  onClick={() => {
                    setIsCitationPanelOpen(false);
                    setActiveCitation(undefined);
                    setActiveCitationBlob(null);
                  }}
                >
                  <img src={CancelIcon} alt="Close" />
                </IconButton>
              </Grid>

              <Typography
                className={styles.citationPanelTitle}
                tabIndex={0}
                title={
                  activeCitation.url && !activeCitation.url.includes("blob.core")
                    ? activeCitation.url
                    : activeCitation.title ?? ""
                }
                sx={{
                  fontWeight: "600",
                  marginBottom: "10px",
                  cursor: activeCitation.url ? "pointer" : "default",
                  color: theme.palette.primary.main,
                  flexShrink: 0,
                  ":hover": activeCitation.url
                    ? { textDecoration: "underline" }
                    : {},
                }}
                onClick={() => {
                  if (activeCitation.url) {
                    onViewSource(activeCitation);
                  }
                }}
              >
                {activeCitation.title}
              </Typography>

              {activeCitation.file_type && (
                <Box sx={{ marginBottom: "10px", flexShrink: 0 }}>
                  <Typography
                    component="span"
                    sx={{
                      display: "inline-block",
                      padding: "4px 12px",
                      backgroundColor: theme.palette.primary.light,
                      color: theme.palette.primary.contrastText,
                      borderRadius: "12px",
                      fontSize: "0.75rem",
                      fontWeight: "bold",
                    }}
                  >
                    {activeCitation.file_type}
                  </Typography>
                </Box>
              )}

              {activeCitation.citation_url && activeCitation.citation_url.length > 0 ? (
                <Box
                  sx={{
                    flex: "1 1 auto",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    border: `1px solid ${theme.palette.divider}`,
                    borderRadius: "4px",
                    overflow: "hidden",
                    minHeight: 0,
                    backgroundColor: "#D2D2D2",
                    maxWidth: "100%",
                  }}
                >
                  {activeCitationBlob ? (
                    <Box
                      sx={{
                        width: "100%",
                        maxWidth: "800px",
                        height: "100%",
                        display: "flex",
                        justifyContent: "center",
                        backgroundColor: "#D2D2D2",
                      }}
                    >
                      {selectedMode === "fast" ? (
                        <SimplePDFViewer
                          pdfBlob={activeCitationBlob}
                          pageNumber={
                            typeof activeCitation.page === "string"
                              ? parseInt(activeCitation.page, 10)
                              : activeCitation.page
                          }
                          onError={(error) => {
                            console.error("PDF viewer error:", error);
                            dispatch(
                              showSnackbar({
                                message: `Error displaying PDF: ${error}`,
                                severity: "error",
                              })
                            );
                          }}
                        />
                      ) : (
                        <SimplePDFViewer
                          pdfBlob={activeCitationBlob}
                          pageNumber={
                            typeof activeCitation.page === "string"
                              ? parseInt(activeCitation.page, 10)
                              : activeCitation.page
                          }
                          citationPosition={activeCitation.citation_position}
                          citationText={activeCitation.citation_text}
                          onError={(error) => {
                            console.error("PDF viewer error:", error);
                            dispatch(
                              showSnackbar({
                                message: `Error displaying PDF: ${error}`,
                                severity: "error",
                              })
                            );
                          }}
                        />
                      )}
                    </Box>
                  ) : (
                    <Box
                      sx={{
                        display: "flex",
                        justifyContent: "center",
                        alignItems: "center",
                        height: "100%",
                      }}
                    >
                      <Typography>Loading PDF...</Typography>
                    </Box>
                  )}
                </Box>
              ) : (
                <Box
                  tabIndex={0}
                  sx={{
                    flex: "1 1 auto",
                    fontSize: "0.9rem",
                    lineHeight: "1.6",
                    color: "#555",
                    backgroundColor: "#fff",
                    padding: "20px",
                    borderRadius: "4px",
                    overflowY: "auto",
                    border: `1px solid ${theme.palette.divider}`,
                    minHeight: 0,
                  }}
                >
                  <ReactMarkdown
                    linkTarget="_blank"
                    className={styles.citationPanelContent}
                    children={DOMPurify.sanitize(activeCitation.content, {
                      ALLOWED_TAGS: XSSAllowTags,
                    })}
                  />
                </Box>
              )}

              <Box
                sx={{
                  marginTop: "20px",
                  paddingTop: "15px",
                  borderTop: `1px solid ${theme.palette.divider}`,
                  flexShrink: 0,
                }}
              >
              </Box>
            </Grid>
          )}

          {isHistoryPanelOpen && (
            <Grid
              sx={{
                width: "30%",
                transition: "width 0.3s ease",
                borderLeft: `1px solid ${theme.palette.divider}`,
                boxShadow: "0px 2px 10px rgba(0, 0, 0, 0.1)",
                padding: "20px",
                backgroundColor: "#D2D2D2",
                borderRadius: 5,
                overflowY: "hidden",
                mb: 3,
                mr: 3,
              }}
              className={styles.citationPanel}
              tabIndex={0}
              role="tabpanel"
              aria-label="Citations Panel"
            >
              <Grid
                container
                justifyContent="space-between"
                alignItems="center"
                className={styles.citationPanelHeaderContainer}
                sx={{
                  borderBottom: `1px solid ${theme.palette.divider}`,
                  paddingBottom: "10px",
                  marginBottom: "20px",
                }}
              >
                <Typography
                  variant="h6"
                  className={styles.citationPanelHeader}
                  sx={{
                    color: "#333",
                  }}
                >
                  History
                </Typography>
                <IconButton
                  aria-label="Close citations panel"
                  onClick={() => setIsHistoryPanelOpen(false)}
                >
                  <img src={CancelIcon} alt="Close" />
                </IconButton>
              </Grid>

              <Grid
                container
                direction="column"
                style={{ width: "-webkit-fill-available" }}
                sx={{
                  height: "100%",
                }}
              >
                <List
                  sx={{
                    flexGrow: 1,
                    minHeight: "300px",
                    maxHeight: "100%",
                    overflowY:
                      historyPanelMockLists.length > 5 ? "auto" : "hidden",
                  }}
                >
                  {historyListFilter?.map((data, index) => (
                    <ListItem key={data.id} disablePadding>
                      <ListItemButton
                        data-value={data.id}
                        onClick={fetchHistoryData}
                        sx={{
                          pt: 2,
                          justifyContent: "space-between",
                          border:
                            data.id == selectedItem
                              ? `1px solid ${theme.palette.primary.main}`
                              : "",
                          borderRadius: 2,
                        }}
                      >
                        <Grid>
                          <Typography>{data.title}</Typography>
                        </Grid>
                        <Grid>
                          <IconButton
                            aria-label="delete"
                            onClick={(event) => {
                              event.stopPropagation();
                              deleteHistory(data.id);
                            }}
                          >
                            <img src={DeleteIcon} alt="Delete" />
                          </IconButton>
                        </Grid>
                      </ListItemButton>
                    </ListItem>
                  ))}
                </List>
              </Grid>
            </Grid>
          )}
        </Grid>
      </Grid>
    </Grid>
  );
};

export default Chat;
