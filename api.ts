import {
	ConversationRequest,
	ChatMessage,
	CosmosDBHealth,
	CosmosDBStatus,
	AuthorizationPayload,
	History,
	ListOfFiles,
	ContractStatus,
	ContractWorkspace,
	UserInfo
} from "./models";
import { v4 as uuidv4 } from "uuid";

const API_URL: string = window.env.VITE_API_URL || "";
let host: string;

if (process.env.NODE_ENV === "local") {
	host = `${API_URL}/api`;
} else {
	host = `/api`;
}


// ------------------------------------------------------------- //
// This file shall be split up based on the path-s
// An abstracted error handling and logging shall be introduced
// ------------------------------------------------------------- //

// refresh token related logic
export async function refreshAccessToken(): Promise<any> {
	const user = JSON.parse(localStorage.getItem("user") || "{}");

	try {
		const response = await fetch(`${host}/auth/refresh-token`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${user.access_token}`,
			},
		});

		if (!response.ok) throw new Error(`Failed to refresh token: ${response.status} ${response.statusText}`);

		const data = await response.json();
		if (data.message === "ExpiredRefreshError") {
			window.location.href = "/";
			localStorage.removeItem("user");
			return null;
		}

		const updatedUser = {
			...user,
			access_token: data.access_token,
		};
		localStorage.setItem("user", JSON.stringify(updatedUser));
		return updatedUser;
	} catch (error: unknown) {
		console.error("Error refreshing access token:", error);
		window.location.href = "/";
		localStorage.removeItem("user");
		throw error;
	}
}

const fetchWithAuth = async (
	url: string,
	options: RequestInit,
): Promise<Response> => {
	const user = JSON.parse(localStorage.getItem("user") || "{}");
	try {
		if (!user.access_token) throw new Error("Access token is missing. Please log in.");

		// Set the Authorization header
		const headers = {
			...options.headers,
			Authorization: `Bearer ${user.access_token}`,
			"X-Request-ID": uuidv4(),
			// "X-Request-ID": crypto.randomUUID()
		};

		// Make the initial fetch request
		let response = await fetch(url, { ...options, headers });

		// Check if the response indicates an expired token
		if (response.status === 401) {
			const errorResponse = await response.json();
			if (errorResponse.payload === "Token Expired") {
				// Attempt to refresh the token
				const updatedUser = await refreshAccessToken();

				// Retry the original request with the new token
				const retryHeaders = {
					...options.headers,
					Authorization: `Bearer ${updatedUser.access_token}`,
				};
				response = await fetch(url, {
					...options,
					headers: retryHeaders,
				});
			} else {
				window.location.href = "/";
				localStorage.removeItem("user");
			}
		}

		return response;
	} catch (error: unknown) {
		console.log('Error fetching with Auth:', error);
		throw error;
	}
}


const downloadFile = async (fileUrl: string, fileName: string) => {
	const response = await fetchWithAuth(fileUrl, {
		method: 'GET',
	});
	const blob = await response.blob();
	const url = window.URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.target = "_blank";
	a.download = fileName;
	document.body.appendChild(a);
	a.click();
	a.remove();
	window.URL.revokeObjectURL(url);
}

// export async function conversationApi(
// 	options: ConversationRequest,
// 	abortSignal: AbortSignal,
// ): Promise<Response> {
// 	try {
// 		const response = await fetchWithAuth(`${host}/conversation`, {
// 			method: "POST",
// 			body: JSON.stringify({
// 				messages: options.messages,
// 			}),
// 			signal: abortSignal,
// 		});

// 		return response;
// 	} catch(error: unknown) {
// 		console.log("Error fetching conversations:", error);
// 	}
// }

export async function authorization(
	payload: AuthorizationPayload,
): Promise<any> {
	try {
		const response = await fetch(`${host}/auth/getAToken`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});

		// Check if the response is successful
		if (!response.ok) {
			return null;
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const data = await response.json();
		const userData = {
			username: "",
			role: "",
			email: "",
			access_token: data.access_token,
		};

		localStorage.setItem("user", JSON.stringify(userData));
		return userData;
	} catch (error) {
		console.error("Error authorizing:", error);
		throw error;
	}
}

export const getUserInfo = async (): Promise<any> => {
	try {
		const response = await fetchWithAuth(`${host}/auth/identity`, {
			method: "GET",
		});

		if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
		const payload = await response.json();
		return payload;
	} catch (error) {
		console.error("Error fetching user info:", error);
		throw error;
	}
};

export const getEstimatedProcessingTime = async (): Promise<any> => {
	try {
		// pass workspace as query params
		const response = await fetchWithAuth(`${host}/chat/history/execution_time`, {
			method: "GET",
		});

		if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
		const payload = await response.json();
		return payload;
	} catch (error) {
		console.error("Error fetching estimate processing time:", error);
		throw error;
	}
};

export const getCitationData = async (fileId: string, pageNumber: string) => {
	// pass workspace as query params
	try {
		const response = await fetchWithAuth(`${host}/chat/citation?file_id=${fileId}&page_label=${pageNumber}`, {
			method: "GET",
		});

		if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
		const payload = await response.json();
		return payload;
	} catch (error) {
		console.error("Error fetching citation data:", error);
		throw error;
	}
};

export const getCitationBlobData = async (citationUrl: string): Promise<Blob> => {
	try {
		const blobResponse = await fetchWithAuth(citationUrl, {
			method: 'GET',
		});
		const blob = await blobResponse.blob();

		return blob;
	} catch (error) {
		console.log("Error fetching citation data: ", error);
		throw error
	}
}

export const historyList = async (offset = 0): Promise<History[] | null> => {
	// pass workspace as query params
	try {
		const response = await fetchWithAuth(`${host}/chat/history/list?offset=${offset}`, {
			method: "GET",
		});

		if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
		const payload = await response.json();
		return payload;
	} catch (error) {
		console.error("Error fetching history list:", error);
		throw error;
	}
};

export const historyRead = async (convId: string): Promise<any> => {
	try {
		const response = await fetchWithAuth(`${host}/chat/history/read`, {
			method: "POST",
			body: JSON.stringify({
				conversation_id: convId,
			}),
		});

		if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
		const payload = await response.json();

		const messages: ChatMessage[] = [];
		if (payload?.messages) {
			payload.messages.forEach((msg: any) => {
				const message: ChatMessage = {
					id: msg.id,
					role: msg.role,
					date: msg.createdAt,
					content: msg.content,
					feedback: msg.feedback ?? undefined,
				};
				messages.push(message);
			});
		}
		return messages;
	} catch (error) {
		console.error("Error fetching history read:", error);
		throw error;
	}
};

// Fix: Promise returned return data instead and updated Chat.tsx usage
export const historyGenerate = async (
	options: ConversationRequest,
	abortSignal: AbortSignal,
	wrkspaceID: string,
	convId?: string,
	multiContractWorkspaceId?: ContractWorkspace[],
	ai_mode?: string
): Promise<Response> => {
	const body = JSON.stringify({
		...(convId && { conversation_id: convId }),
		messages: options.messages,
		contract_workspace_id: wrkspaceID,
		contract_workspace_list: multiContractWorkspaceId,
		ai_mode: ai_mode || "standard",
	});

	try {
		const response = await fetchWithAuth(`${host}/chat/history/generate`, {
			method: "POST",
			body: body,
			signal: abortSignal,
		});

		return response;
	} catch (error) {
		console.error("Error executing history generate:", error);
		throw error;
	}
};

export const historyUpdate = async (
	messages: ChatMessage[],
	convId: string,
): Promise<Response> => {
	try {
		const response = await fetchWithAuth(`${host}/chat/history/update`, {
			method: "POST",
			body: JSON.stringify({
				conversation_id: convId,
				messages: messages,
			}),
		});
		return response;
	} catch (error) {
		console.error("Error executing history update:", error);
		// throw error;
		return {
			...new Response(),
			ok: false,
			status: 500,
		};
	}
};

export const historyDelete = async (convId: string): Promise<Response> => {
	try {
		const response = await fetchWithAuth(`${host}/chat/history/delete`, {
			method: "DELETE",
			body: JSON.stringify({
				conversation_id: convId,
			}),
			headers: {
				"Content-Type": "application/json",
			},
		});

		return response;
	} catch (error: unknown) {
		console.error("Error executing history delete:", error);
		// throw error;
		return {
			...new Response(),
			ok: false,
			status: 500,
		};
	}
};

export const historyDeleteAll = async (): Promise<Response> => {
	try {
		const response = await fetchWithAuth(`${host}/chat/history/delete_all`, {
			method: "DELETE",
			body: JSON.stringify({}),
		});
		return response;
	} catch (error: unknown) {
		console.error("Error executing history delete all:", error);
		// throw error;
		return {
			...new Response(),
			ok: false,
			status: 500,
		};
	}
};

export const historyClear = async (convId: string): Promise<Response> => {
	try {
		const response = await fetchWithAuth(`${host}/chat/history/clear`, {
			method: "POST",
			body: JSON.stringify({
				conversation_id: convId,
			}),
			headers: {
				"Content-Type": "application/json",
			},
		});
		return response;
	} catch (error: unknown) {
		console.error("Error executing history clear:", error);
		// throw error;
		return {
			...new Response(),
			ok: false,
			status: 500,
		};
	}
};

export const historyRename = async (
	convId: string,
	title: string,
): Promise<Response> => {
	try {
		const response = await fetchWithAuth(`${host}/chat/history/rename`, {
			method: "POST",
			body: JSON.stringify({
				conversation_id: convId,
				title: title,
			}),
			headers: {
				"Content-Type": "application/json",
			},
		});
		return response;
	} catch (error: unknown) {
		console.error("Error executing history rename:", error);
		// throw error;
		return {
			...new Response(),
			ok: false,
			status: 500,
		};
	}
};

export const historyEnsure = async (): Promise<CosmosDBHealth> => {
	try {
		const response = await fetchWithAuth(`${host}/chat/history/ensure`, {
			method: "GET",
		});

		let formattedResponse = null;
		if (response) {
			const respJson = await response.json();
			if (response.ok && respJson.message) {
				formattedResponse = CosmosDBStatus.Working;
			} else if (response.status === 500) {
				formattedResponse = CosmosDBStatus.NotWorking;
			} else if (response.status === 401) {
				formattedResponse = CosmosDBStatus.InvalidCredentials;
			} else if (response.status === 422) {
				formattedResponse = respJson.error;
			} else {
				formattedResponse = CosmosDBStatus.NotConfigured;
			}
		}
		return {
			cosmosDB: response?.ok,
			status: formattedResponse,
		} as CosmosDBHealth;
	} catch (error) {
		console.error("Error executing history ensure:", error);
		// throw error;
		return {
			cosmosDB: false,
			status: (error as Error).message,
		} as CosmosDBHealth;
	}
};

export const historyMessageFeedback = async (
	convId: string | undefined,
	messageId: string,
	feedback: string,
	additionalFeedback: string,
): Promise<Response> => {
	try {
		const response = await fetchWithAuth(`${host}/chat/threads/${convId}/messages/${messageId}`, {
			method: "POST",
			body: JSON.stringify({
				conversation_id: convId,
				message_id: messageId,
				message_feedback: feedback,
				additional_feedback: additionalFeedback,
			}),
		},
		);

		return response;
	} catch (error) {
		console.error("Error executing history message feedback:", error);
		// throw error;
		return {
			...new Response(),
			ok: false,
			status: 500,
		};
	}
};

export async function downloadExport(
	site_index: string,
	fileId: number,
): Promise<string> {
	try {
		const response = await fetchWithAuth(`${host}/default/download_export/${fileId}`, {
			method: "GET",
		});

		if (!response.ok) throw new Error(`Failed to download file (file_id: ${fileId}): ${response.status}`);

		const responseJson = await response.json();
		return responseJson.sasUrl;
	} catch (error) {
		console.error("Error executing download export:", error);
		throw error;
	}
}

export async function listReadyFiles(): Promise<ListOfFiles[]> {
	try {
		const response = await fetchWithAuth(`${host}/default/ready_file`, {
			method: "GET",
		});

		if (!response.ok) throw new Error(`Failed to get files: ${response.status}`);
		const responseJson = await response.json();

		const newFiles: any[] = [];
		Object.keys(responseJson).forEach((fileKey) => {
			const file = responseJson[fileKey];

			if (file["Metadata"]) {
				file["Metadata"] = JSON.parse(file["Metadata"]);
			}
			newFiles.push(file);
		});
		return responseJson;
	} catch (error) {
		console.error("Error executing list ready files:", error);
		throw error;
	}
}

export async function listFiles(): Promise<ListOfFiles[]> {
	try {
		const response = await fetchWithAuth(`${host}/default/file`, {
			method: "GET",
		});

		if (!response.ok) throw new Error(`Failed to get files: ${response.status}`);

		const responseJson = await response.json();

		const newFiles: any[] = [];
		Object.keys(responseJson).forEach((fileKey) => {
			const file = responseJson[fileKey];

			if (file["Metadata"]) {
				file["Metadata"] = JSON.parse(file["Metadata"]);
			}
			newFiles.push(file);
		});
		return responseJson;
	} catch (error) {
		console.error("Error executing list files:", error);
		throw error;
	}
}

export async function uploadFile(
	formData: FormData,
	onProgress: (percent: number) => void,
): Promise<Response> {
	try {
		const response = await fetchWithAuth(`${host}/default/file`, {
			method: "POST",
			body: formData,
		});

		if (!response.ok) throw new Error(`Failed to upload file: ${response.status}`);

		// Check if response body is available
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Failed to get response body for progress tracking.");

		const contentLength = response.headers.get("Content-Length");
		const totalLength = contentLength ? parseInt(contentLength, 10) : null;

		let receivedLength = 0;
		const chunks = [];

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			receivedLength += value.length;

			if (totalLength) {
				const percentComplete = (receivedLength / totalLength) * 100;
				onProgress(percentComplete);
			}
		}

		return new Response(new Blob(chunks)); // Handle the response as needed
	} catch (error) {
		console.error("Error executing upload file:", error);
		throw error;
	}
}

export async function viewContractFile(fileId: number): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/default/contract/${fileId}`, {
			method: "GET",
		});
		if (!response.ok) throw new Error(`Failed to view contract: ${response.status}`);

		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing view contract file:", error);
		throw error;
	}
}

export async function DeleteFile(fileId: number): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/default/file/${fileId}`, {
			method: "DELETE",
		});
		if (!response.ok) throw new Error(`Failed to Delete File: ${response.status}`);

		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing delete file:", error);
		throw error;
	}
}

export async function getContractStatus(): Promise<ContractStatus[]> {
	try {
		const response = await fetchWithAuth(`${host}/default/contract`, {
			method: "GET",
		});

		if (!response.ok) throw new Error(`Failed to get status: ${response.status}`);

		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing get contract status:", error);
		throw error;
	}
}

export const getContractList = async (
	searchTerm: string,
	sortBy: string,
	filterParams?: any,
	offset?: number,
	limit?: number
): Promise<any> => {
	try {
		// Build query parameters
		const queryParams = new URLSearchParams();

		if (searchTerm) queryParams.append('name', searchTerm);
		if (sortBy) queryParams.append('order_by', sortBy);
		// Add filter parameters if provided
		if (filterParams) {
			// Handle contract types (comma-separated)
			if (filterParams.contractTypes) queryParams.append('contract_types', filterParams.contractTypes);
			// Handle sharing type
			if (filterParams.sharingType) queryParams.append('sharing_type', filterParams.sharingType);
		}
		if (offset !== undefined && offset !== null) queryParams.set("offset", String(offset));
		if (limit !== undefined && limit !== null) queryParams.set("limit", String(limit));

		console.log(`offset: ${offset}, limit: ${limit}`);
		const response = await fetchWithAuth(`${host}/contract-mgmt/contracts?${queryParams.toString()}`, {
			method: 'GET',
		});
		const data = await response.json();
		return data;
	} catch (error) {
		console.error("Error executing get contract list:", error);

		let errorMessage = 'Failed to fetch contract list';
		if (error instanceof Error) {
			errorMessage = error.message;
		} else if (typeof error === 'string') {
			errorMessage = error;
		} else if (error && typeof error === 'object' && 'message' in error) {
			errorMessage = String((error as { message: unknown }).message);
		}
		return {
			success: false,
			message: 'Failed to fetch contract list',
			payload: errorMessage,
		};
	}
};

export const getContractsForDropdowns = async (
	searchTerm: string,
	offset?: number,
	limit?: number
): Promise<{
    items: { id: string, label: string}[];
    hasMore: boolean;
}> => {
	try {
		// Build query parameters
		const queryParams = new URLSearchParams();

		if (searchTerm) queryParams.append('name', searchTerm);
		if (offset !== undefined && offset !== null) queryParams.append("offset", String(offset));
		if (limit !== undefined && limit !== null) queryParams.append("limit", String(limit));

        console.log(`offset: ${offset}, limit: ${limit}`);
		const response = await fetchWithAuth(`${host}/contract-mgmt/only_contracts?${queryParams.toString()}`, {
			method: 'GET',
		});
		const data = await response.json();
		return {
            items: data.contracts.map((c: any) => ({
                id: String(c.contract_id),
                label: c.contract_workspace,
            })),
            hasMore: data.has_more,
            };
	} catch (error) {
		console.error("Error executing get contract list:", error);
		let errorMessage = 'Failed to fetch contract list';
		if (error instanceof Error) {
			errorMessage = error.message;
		} else if (typeof error === 'string') {
			errorMessage = error;
		} else if (error && typeof error === 'object' && 'message' in error) {
			errorMessage = String((error as { message: unknown }).message);
		}
		return {
			success: false,
			message: 'Failed to fetch contract list',
			payload: errorMessage,
		};
	}
};

export async function getContractAttributes(
	cwID: number,
	questionVal: string,
	search: string = "",
	templateIds?: number[]
): Promise<any> {
	try {
		let url = `${host}/attribute-mgmt/answers?question_set=${questionVal}&contract_workspace_id=${cwID}&attrb_name=${search}`;

		// Add template IDs if provided
		if (templateIds && templateIds.length > 0) {
			url += `&template=${templateIds.join(',')}`;
		}

		const response = await fetchWithAuth(url, {
			method: "GET",
		});

		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing get contract attributes:", error);
		throw error;
	}
}

export async function getUpdateAttributes(
	cwID: number,
	formData: {},
	questionVal: string
): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/attribute-mgmt/answers?question_set=${questionVal}&contract_workspace_id=${cwID}`, {
			method: "POST",
			body: JSON.stringify(formData),
			headers: {
				"Content-Type": "application/json",
			},
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing :", error);
		throw error;
	}
}

export async function createCW(payload: any): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/contract-mgmt/contract`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing :", error);
		throw error;
	}
}


export const getExportData = async (
	contractIds: number[],
	queVal: string,
	templateIds?: number[],
	fileName?: string
): Promise<any> => {
	try {
		let endpoint = `${host}/attribute-mgmt/export-answers?question_set=${queVal}&`;
		const params = new URLSearchParams();

		// Add contract IDs
		if (contractIds && contractIds.length > 0) contractIds.forEach(id => params.append('contract_ids', id.toString()));
		// Add template IDs if provided
		if (templateIds && templateIds.length > 0) templateIds.forEach(id => params.append('template_ids', id.toString()));
		// Add filename if provided
		if (fileName) params.append('file_name', fileName);

		// Append params to endpoint
		if (params.toString()) endpoint += `${params.toString()}`;

		const response = await fetchWithAuth(endpoint, {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json',
			},
		});
		const jsonResponse = await response.json();
		if (jsonResponse && jsonResponse.success) {
			const fileUrl = jsonResponse?.data?.url;
			await downloadFile(fileUrl, `${fileName}.xlsx`);
		}

		return jsonResponse;
	} catch (error) {
		console.error('Export Data error:', error);
		return { success: false, message: error instanceof Error ? error.message : 'Export failed' };
	}
};

export async function getDeleteAttributes(
	cwID: number,
	formData: {},
	questionVal: string
): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/attribute-mgmt/answers?question_set=${questionVal}&contract_workspace_id=${cwID}`, {
			method: "Delete",
			body: JSON.stringify(formData),
			headers: {
				"Content-Type": "application/json",
			},
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing delete attributes:", error);
		throw error;
	}
}

export async function uploadFiles(
	formData: FormData,
	cwId: string,
): Promise<Response> {
	try {
		const response = await fetchWithAuth(`${host}/contract-mgmt/file?contract_workspace_id=${cwId}`, {
			method: "POST",
			body: formData,
		});

		const reader = response.body?.getReader();
		if (!reader) throw new Error("Failed to get response body for progress tracking.");

		// Check if response body is available
		const contentLength = response.headers.get("Content-Length");
		const totalLength = contentLength ? parseInt(contentLength, 10) : null;

		let receivedLength = 0;
		const chunks = [];

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			receivedLength += value.length;
		}

		return new Response(new Blob(chunks));
	} catch (error) {
		console.error("Error executing upload files:", error);
		throw error;
	}
}

export async function getDocuments(
	id: any,
	search: any,
	page: any,
	rowsperpage: any
): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/contract-mgmt/files?contract_workspace_id=${id}&name=${search}&page_number=${page}&page_size=${rowsperpage}`, {
			method: "GET",
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing get documents:", error);
		throw error;
	}
}

export async function DeleteCWrkspace(id: string): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/contract-mgmt/contract?contract_workspace_id=${id}`, {
			method: "DELETE",
		});

		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing delete contract WS:", error);
		throw error;
	}
}

export async function DeleteFiles(fileId: any): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/contract-mgmt/file?file_id=${fileId}`, {
			method: "DELETE",
		});

		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing delete files:", error);
		throw error;
	}
}

export async function updateContractDetails(payload: any): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/contract-mgmt/contract`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing updateContractDetails:", error);
		throw error;
	}
}

export async function getUpdateRateCard(
	cwID: number,
	formData: {},
	questionVal: string,
	addEditRow: boolean
): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/attribute-mgmt/answers?question_set=${questionVal}&contract_workspace_id=${cwID}&add_row=${addEditRow}`, {
			method: "POST",
			body: JSON.stringify(formData),
			headers: {
				"Content-Type": "application/json",
			},
		});

		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing getUpdateRateCard:", error);
		throw error;
	}
}

export async function getDeleteUpdateRateCard(
	cwID: number,
	formData: {},
	questionVal: string,
	deleteType: string
): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/attribute-mgmt/answers?question_set=${questionVal}&contract_workspace_id=${cwID}&delete_type=${deleteType}`, {
			method: "Delete",
			body: JSON.stringify(formData),
			headers: {
				"Content-Type": "application/json",
			},
		});

		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing getDeleteUpdateRateCard:", error);
		throw error;
	}
}

export async function getUpdateItsRateCard(
	cwID: number,
	formData: {},
	questionVal: string,
	addEditRow: boolean
): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/attribute-mgmt/answers?question_set=${questionVal}&contract_workspace_id=${cwID}&add_row=${addEditRow}`, {
			method: "POST",
			body: JSON.stringify(formData),
			headers: {
				"Content-Type": "application/json",
			},
		});

		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing getUpdateItsRateCard:", error);
		throw error;
	}
}

export async function getDeleteUpdateItsRateCard(
	cwID: number,
	formData: {},
	questionVal: string,
	deleteType: string
): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/attribute-mgmt/answers?question_set=${questionVal}&contract_workspace_id=${cwID}&delete_type=${deleteType}`, {
			method: "Delete",
			body: JSON.stringify(formData),
			headers: {
				"Content-Type": "application/json",
			},
		});

		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing getDeleteUpdateItsRateCard:", error);
		throw error;
	}
}


export const getPBIConfig = async (): Promise<any> => {
	try {
		const response = await fetchWithAuth(`${host}/contract-comparison/getembedinfo`, {
			method: "GET",
		});
		const payload = await response.json();
		return payload;
	} catch (error) {
		console.error("Error executing getPBIConfig:", error);
		throw error;
	}
};

export const getAttrbPageConfig = async (): Promise<any> => {
	try {
		const response = await fetchWithAuth(`${host}/users/getattrbpageinfo`, {
			method: "GET",
		});
		const payload = await response.json();
		return payload;
	} catch (error) {
		console.error("Error executing getAttrbPageConfig:", error);
		throw error;
	}
};

export async function exportDocuments(fileId: any, fileName: string): Promise<any> {
	try {
		const response: any = await fetchWithAuth(`${host}/contract-mgmt/download-file?file_id=${fileId}`, {
			method: "GET",
		});

		const jsonResponse = await response.json()
		if (jsonResponse && jsonResponse.success) {
			const fileUrl = jsonResponse?.data?.url;
			await downloadFile(fileUrl, `${fileName}.pdf`);
		}
		return jsonResponse;
	} catch (error) {
		console.error("Error executing exportDocuments:", error);
		throw error;
	}
}

export async function getCustomPanelList(
	panelName: string = '',
	orderBy: string = ''
): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panels?panel_name=${encodeURIComponent(panelName)}&order_by=${encodeURIComponent(orderBy)}`, {
			method: "GET"
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing getCustomPanelList:", error);
		// throw error;
		return null;
	}
}

export async function createTemplate(payload: any): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing createTemplate:", error);
		throw error;
	}
}

export async function deleteTemplate(id: string): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel/${id}`, {
			method: "DELETE",
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing deleteTemplate:", error);
		throw error;
	}
}

export async function getQuestions(id: string): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel/${id}/questions`, {
			method: "GET",
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing getQuestions:", error);
		throw error;
	}
}

export async function getAribaMetadata(documentId: string): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/ariba-mgmt/metadata-fetching/${documentId}/documents`, {
			method: "GET",
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing getAribaMetadata:", error);
		throw error;
	}
}

export async function sendSelectedDocuments(payload: any): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/ariba-mgmt/submit-documents`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload),
		});
		const data = await response.json();
		return data;
	} catch (error) {
		console.error("Error executing sendSelectedDocuments:", error);
		throw error;
	}
}

export async function getContracts(panelId: string): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel/${panelId}/contracts`, {
			method: "GET",
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing getContracts:", error);
		throw error;
	}
}

export async function updateTemplate(payload: any): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing updateTemplate:", error);
		throw error;
	}
}

export async function getPanelExportData(id: string): Promise<Response> {
	try {
		const response: any = await fetchWithAuth(`${host}/template-mgmt/custom-panel/${id}/export`, {
			method: "GET",
		});

		const jsonResponse = await response.json();
		if (jsonResponse && jsonResponse.success) {
			const fileUrl = jsonResponse?.data?.url;
			await downloadFile(fileUrl, `UCP_${id}_custom_template.xlsx`);
		}

		return jsonResponse;
	} catch (error) {
		console.error("Error executing getPanelExportData:", error);
		throw error;
	}
}

export async function addQuestion(
	panelId: string,
	question: string,
	businessLogic: string,
	instructions: string,
	knowledgeBase: string,
	knowledgeBaseReference: string
): Promise<Response> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel/${panelId}/question`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ question, businessLogic, instructions, knowledgeBase, knowledgeBaseReference })
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing addQuestion:", error);
		throw error;
	}
}

export async function editQuestion(
	panelId: string,
	questionId: string,
	question: string,
	businessLogic: string,
	instructions: string,
	knowledgeBase: string,
	knowledgeBaseReference: string
): Promise<Response> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel/${panelId}/question/${questionId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ question, businessLogic, instructions, knowledgeBase, knowledgeBaseReference })
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing editQuestion:", error);
		throw error;
	}
}

export async function addContract(
	panelId: string,
	contractIds: string[]
): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel/${panelId}/contract`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ contract_ids: contractIds })
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing addContract:", error);
		throw error;
	}
}

export async function deletePanelQuestion(
	panel_id: number,
	question_id: number
): Promise<Response> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel/${panel_id}/question/${question_id}`, {
			method: "DELETE",
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing deletePanelQuestion:", error);
		throw error;
	}
}

export async function deletePanelContract(
	panel_id: number,
	contract_id: number
): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel/${panel_id}/contract/${contract_id}`, {
			method: "DELETE",
		});
		if (!response.ok) {
			throw new Error(`Failed to delete contract: ${response.status}`);
		}
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing deletePanelContract:", error);
		throw error;
	}
}


export async function shareContract(contractId: string): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/contract-mgmt/share`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ contract_id: contractId }),
		});

		if (!response.ok) throw new Error(`Failed to share contract: ${response.status}`);

		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing shareContract:", error);
		throw error;
	}
}

export async function unshareContract(contractId: string): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/contract-mgmt/unshare`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ contract_id: contractId }),
		});

		if (!response.ok) {
			const contentType = response.headers.get("content-type");
			if (contentType && contentType.includes("text/html")) {
				const errorText = await response.text();
				console.error("HTML error response:", errorText);
				throw new Error("Received HTML error response from server");
			}
			throw new Error(`Failed to unshare contract: ${response.status}`);
		}

		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing unshareContract:", error);
		throw error;
	}
}


export async function getWorkspacePanels(
	workspaceId: string,
	panelName: string = '',
	orderBy: string = ''
): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/workspace-panels/${workspaceId}?panel_name=${encodeURIComponent(panelName)}&order_by=${encodeURIComponent(orderBy)}`, {
			method: "GET"
		});

		if (!response.ok) {
			// Handle different error status codes
			if (response.status === 500) {
				return {
					success: true,
					data: [],
					message: "No panels found for this workspace"
				};
			}
		}

		const data = await response.json();
		return data;
	} catch (error) {
		console.error("Error fetching workspace panels:", error);
		// Return a graceful failure that the UI can handle
		return {
			success: false,
			data: [],
			message: `Error fetching panels: ${error}`
		};
	}
}

export async function generateBusinessLogic(
	question: string,
	kbName: string,
	instructions: string
): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel/generate-business-logic`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ question, kbName, instructions })
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing generateBusinessLogic:", error);
		throw error;
	}
}

export async function getKnowledgeBases(): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel/knowledge-bases`, {
			method: "GET",
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing getKnowledgeBases:", error);
		throw error;
	}
}

export async function uploadFileToKnowledgeBase(
	formData: FormData,
	kbID: string
): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/knowledge_base?knowledge_base_id=${kbID}`, {
			method: "POST",
			body: formData,
		});

		// Check if the response is ok before proceeding
		if (!response.ok) {
			const errorText = await response.text();
			let errorData;
			try {
				errorData = JSON.parse(errorText);
			} catch (e) {
				// If not valid JSON, use the text as is
				errorData = { message: errorText };
			}
			throw new Error(`Upload failed with status ${response.status}: ${errorData?.message || response.statusText}`);
		}

		// Rest of the function remains the same...
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Failed to get response body for progress tracking.");

		// Check if response body is available
		const contentLength = response.headers.get("Content-Length");
		const totalLength = contentLength ? parseInt(contentLength, 10) : null;

		let receivedLength = 0;
		const chunks = [];

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			receivedLength += value.length;
		}

		// Parse the response as JSON if possible
		const blob = new Blob(chunks);
		const text = await blob.text();
		try {
			return JSON.parse(text);
		} catch (e) {
			// If not valid JSON, return the raw response
			return { success: true, data: text };
		}
	} catch (error) {
		console.error("Error uploading file to knowledge base:", error);
		throw error;
	}
}

export async function createKnowledgeBase(payload: any): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel/knowledge-base`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing createKnowledgeBase:", error);
		throw error;
	}
}

export const updateKnowledgeBase = async (
	knowledge_base_id: number,
	payload: {
		name?: string,
		description?: string,
		status?: string,
		share?: 'share' | 'unshare'
	}
): Promise<any> => {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel/knowledge-base/${knowledge_base_id}`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});
		if (!response.ok) throw new Error(`Failed to update knowledge base: ${response.status}`);
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing updateKnowledgeBase:", error);
		throw error;
	}
}

export async function deleteKnowledgeBase(knowledge_base_id: number): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel/${knowledge_base_id}/knowledge-base`, {
			method: "DELETE",
		});
		if (!response.ok) throw new Error(`Failed to delete knowledge base: ${response.status}`);
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing deleteKnowledgeBase:", error);
		throw error;
	}
}

export async function deleteKnowledgeBaseDocument(knowledge_base_doc_id: number): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel/${knowledge_base_doc_id}/knowledge-base-document`, {
			method: "DELETE",
		});
		if (!response.ok) throw new Error(`Failed to delete knowledge base: ${response.status}`);
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing deleteKnowledgeBaseDocument:", error);
		throw error;
	}
}

export async function getRepositoryTemplates(): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel-repository`, {
			method: "GET"

		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing getRepositoryTemplates:", error);
		throw error;
	}
}

export async function shareTemplate(templateId: string): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel-repository/${templateId}/share`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ template_id: templateId }),
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing shareTemplate:", error);
		throw error;
	}
}

export async function deleteRepository(id: string): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/template-mgmt/custom-panel-repository/${id}`, {
			method: "DELETE",
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing deleteRepository:", error);
		throw error;
	}
}

export async function getUserDepartmentInfo(): Promise<any> {
	try {
		const response = await fetchWithAuth(`${host}/users/department_info`, {
			method: "GET",
		});
		const responseJson = await response.json();
		return responseJson;
	} catch (error) {
		console.error("Error executing getUserDepartmentInfo:", error);
		throw error;
	}
}
