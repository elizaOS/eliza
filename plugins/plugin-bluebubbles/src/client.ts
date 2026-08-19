/**
 * Thin REST wrapper over the BlueBubbles server HTTP API: sends messages and
 * attachments, queries chats/messages, marks read, reacts, and edits/unsends
 * (edit and unsend require the BlueBubbles Private API). Authenticates by
 * appending the server password as a query parameter to every request; the
 * service layer owns all higher-level routing and envelope mapping.
 */
import { API_ENDPOINTS } from "./constants";
import type {
	BlueBubblesChat,
	BlueBubblesConfig,
	BlueBubblesMessage,
	BlueBubblesProbeResult,
	BlueBubblesServerInfo,
	SendAttachmentOptions,
	SendMessageOptions,
	SendMessageResult,
} from "./types";

const BLUEBUBBLES_REQUEST_TIMEOUT_MS = 15_000;

/** Binary attachment POSTs share the documented 30s blob-upload sibling budget. */
const BLUEBUBBLES_ATTACHMENT_TIMEOUT_MS = 30_000;

interface BlueBubblesFetchResponse {
	ok: boolean;
	status: number;
	text(): Promise<string>;
	json(): Promise<unknown>;
}

async function blueBubblesRequest<T>(
	urlWithPassword: string,
	options: RequestInit = {},
): Promise<T> {
	const timeoutSignal = AbortSignal.timeout(BLUEBUBBLES_REQUEST_TIMEOUT_MS);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeoutSignal])
		: timeoutSignal;
	const response = (await fetch(urlWithPassword, {
		...options,
		headers: {
			"Content-Type": "application/json",
			...options.headers,
		},
		signal,
	})) as BlueBubblesFetchResponse;

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`BlueBubbles API error (${response.status}): ${errorText}`);
	}

	return response.json() as Promise<T>;
}

async function blueBubblesSendAttachment(
	url: string,
	formData: FormData,
): Promise<{ data: BlueBubblesMessage }> {
	const response = (await fetch(url, {
		method: "POST",
		body: formData,
		signal: AbortSignal.timeout(BLUEBUBBLES_ATTACHMENT_TIMEOUT_MS),
	})) as BlueBubblesFetchResponse;

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Failed to send attachment: ${errorText}`);
	}

	return (await response.json()) as { data: BlueBubblesMessage };
}

export class BlueBubblesClient {
	private baseUrl: string;
	private password: string;

	constructor(config: BlueBubblesConfig) {
		this.baseUrl = config.serverUrl.replace(/\/$/, "");
		this.password = config.password;
	}

	private async request<T>(
		endpoint: string,
		options: RequestInit = {},
	): Promise<T> {
		const url = `${this.baseUrl}${endpoint}`;
		const separator = endpoint.includes("?") ? "&" : "?";
		const urlWithPassword = `${url}${separator}password=${encodeURIComponent(this.password)}`;

		return blueBubblesRequest<T>(urlWithPassword, options);
	}

	/**
	 * Probes the BlueBubbles server to check connectivity and capabilities
	 */
	async probe(timeoutMs = 5000): Promise<BlueBubblesProbeResult> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

		try {
			const info = await this.request<{ data: BlueBubblesServerInfo }>(
				API_ENDPOINTS.SERVER_INFO,
				{ signal: controller.signal },
			);

			return {
				ok: true,
				serverVersion: info.data.server_version,
				osVersion: info.data.os_version,
				privateApiEnabled: info.data.private_api,
				helperConnected: info.data.helper_connected,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				error: errorMessage,
			};
		} finally {
			clearTimeout(timeoutId);
		}
	}

	/**
	 * Returns the authenticated fetch URL for an attachment. The server
	 * password is appended only here, at fetch time — attachment URLs persisted
	 * on memories are bare capability URLs without the credential.
	 */
	getAttachmentUrl(attachmentGuid: string): string {
		return `${this.baseUrl}/api/v1/attachment/${encodeURIComponent(attachmentGuid)}?password=${encodeURIComponent(this.password)}`;
	}

	/**
	 * Sends a text message
	 */
	async sendMessage(
		chatGuid: string,
		text: string,
		options: SendMessageOptions = {},
	): Promise<SendMessageResult> {
		const response = await this.request<{ data: BlueBubblesMessage }>(
			API_ENDPOINTS.MESSAGE_TEXT,
			{
				method: "POST",
				body: JSON.stringify({
					chatGuid,
					message: text,
					tempGuid: options.tempGuid,
					method: options.method ?? "apple-script",
					subject: options.subject,
					effectId: options.effectId,
					selectedMessageGuid: options.selectedMessageGuid,
					partIndex: options.partIndex,
					ddScan: options.ddScan,
				}),
			},
		);

		return {
			guid: response.data.guid,
			tempGuid: options.tempGuid,
			status: "sent",
			dateCreated: response.data.dateCreated,
			text: response.data.text ?? text,
		};
	}

	/**
	 * Sends an attachment
	 */
	async sendAttachment(
		chatGuid: string,
		attachmentPath: string,
		options: SendAttachmentOptions = {},
	): Promise<SendMessageResult> {
		const formData = new FormData();
		formData.append("chatGuid", chatGuid);
		formData.append("attachment", attachmentPath);

		if (options.tempGuid) {
			formData.append("tempGuid", options.tempGuid);
		}
		if (options.name) {
			formData.append("name", options.name);
		}
		if (options.isAudioMessage !== undefined) {
			formData.append("isAudioMessage", String(options.isAudioMessage));
		}

		const url = `${this.baseUrl}${API_ENDPOINTS.SEND_ATTACHMENT}?password=${encodeURIComponent(this.password)}`;
		const result = await blueBubblesSendAttachment(url, formData);

		return {
			guid: result.data.guid,
			tempGuid: options.tempGuid,
			status: "sent",
			dateCreated: result.data.dateCreated,
			text: result.data.text ?? "",
		};
	}

	/**
	 * Sends an attachment from a buffer
	 */
	async sendAttachmentBuffer(
		chatGuid: string,
		buffer: Uint8Array,
		filename: string,
		mimeType: string,
		caption?: string,
	): Promise<SendMessageResult> {
		const blobBuffer = buffer.buffer.slice(
			buffer.byteOffset,
			buffer.byteOffset + buffer.byteLength,
		);
		const blob = new Blob([blobBuffer as ArrayBuffer], { type: mimeType });
		const formData = new FormData();
		formData.append("chatGuid", chatGuid);
		formData.append("attachment", blob, filename);
		if (caption) {
			formData.append("message", caption);
		}

		const url = `${this.baseUrl}${API_ENDPOINTS.SEND_ATTACHMENT}?password=${encodeURIComponent(this.password)}`;
		const result = await blueBubblesSendAttachment(url, formData);

		return {
			guid: result.data.guid,
			status: "sent",
			dateCreated: result.data.dateCreated,
			text: caption ?? "",
		};
	}

	/**
	 * Gets information about a chat
	 */
	async getChat(chatGuid: string): Promise<BlueBubblesChat> {
		const response = await this.request<{ data: BlueBubblesChat }>(
			`${API_ENDPOINTS.CHAT_INFO}/${encodeURIComponent(chatGuid)}`,
		);
		return response.data;
	}

	/**
	 * Lists all chats
	 */
	async listChats(limit = 100, offset = 0): Promise<BlueBubblesChat[]> {
		const response = await this.request<{ data: BlueBubblesChat[] }>(
			API_ENDPOINTS.CHAT_QUERY,
			{
				method: "POST",
				body: JSON.stringify({
					limit,
					offset,
					with: ["lastMessage", "participants"],
				}),
			},
		);
		return response.data;
	}

	/**
	 * Gets messages for a chat
	 */
	async getMessages(
		chatGuid: string,
		limit = 50,
		offset = 0,
	): Promise<BlueBubblesMessage[]> {
		const response = await this.request<{ data: BlueBubblesMessage[] }>(
			`${API_ENDPOINTS.CHAT_INFO}/${encodeURIComponent(chatGuid)}/message?limit=${limit}&offset=${offset}`,
		);
		return response.data;
	}

	/**
	 * Marks a chat as read
	 */
	async markChatRead(chatGuid: string): Promise<void> {
		const endpoint = API_ENDPOINTS.MARK_READ.replace(
			":guid",
			encodeURIComponent(chatGuid),
		);
		await this.request(endpoint, {
			method: "POST",
		});
	}

	/**
	 * Sends a reaction to a message
	 */
	async reactToMessage(
		chatGuid: string,
		messageGuid: string,
		reaction: string,
	): Promise<void> {
		await this.request(API_ENDPOINTS.REACT, {
			method: "POST",
			body: JSON.stringify({
				chatGuid,
				messageGuid,
				reaction,
			}),
		});
	}

	/**
	 * Edits a message (requires private API)
	 */
	async editMessage(
		messageGuid: string,
		newText: string,
		backwardsCompatMessage?: string,
	): Promise<void> {
		const endpoint = API_ENDPOINTS.EDIT.replace(
			":guid",
			encodeURIComponent(messageGuid),
		);
		await this.request(endpoint, {
			method: "POST",
			body: JSON.stringify({
				editedMessage: newText,
				backwardsCompatibilityMessage: backwardsCompatMessage ?? newText,
			}),
		});
	}

	/**
	 * Unsends a message (requires private API)
	 */
	async unsendMessage(messageGuid: string): Promise<void> {
		const endpoint = API_ENDPOINTS.UNSEND.replace(
			":guid",
			encodeURIComponent(messageGuid),
		);
		await this.request(endpoint, {
			method: "POST",
		});
	}

	/**
	 * Resolves a target (handle or chat GUID) to a chat GUID
	 */
	async resolveTarget(target: string): Promise<string> {
		// If it already looks like a chat GUID, return it
		if (target.startsWith("iMessage;") || target.startsWith("SMS;")) {
			return target;
		}

		// If it looks like a chat ID or identifier, query for it
		if (target.startsWith("chat_")) {
			const chats = await this.listChats();
			const chat = chats.find(
				(c) =>
					c.chatIdentifier === target ||
					c.guid === target ||
					c.chatIdentifier.includes(target),
			);
			if (chat) {
				return chat.guid;
			}
		}

		// Otherwise, construct a DM chat GUID
		// First try as iMessage, which is most common
		return `iMessage;-;${target}`;
	}

	/**
	 * Creates a new group chat
	 */
	async createGroupChat(
		participants: string[],
		name?: string,
		message?: string,
	): Promise<BlueBubblesChat> {
		const response = await this.request<{ data: BlueBubblesChat }>(
			API_ENDPOINTS.CREATE_CHAT,
			{
				method: "POST",
				body: JSON.stringify({
					addresses: participants,
					name,
					message,
					service: "iMessage",
				}),
			},
		);
		return response.data;
	}

	/**
	 * Adds a participant to a group chat
	 */
	async addParticipant(chatGuid: string, handle: string): Promise<void> {
		await this.request(
			`${API_ENDPOINTS.CHAT_INFO}/${encodeURIComponent(chatGuid)}/participant`,
			{
				method: "POST",
				body: JSON.stringify({ address: handle }),
			},
		);
	}

	/**
	 * Removes a participant from a group chat
	 */
	async removeParticipant(chatGuid: string, handle: string): Promise<void> {
		await this.request(
			`${API_ENDPOINTS.CHAT_INFO}/${encodeURIComponent(chatGuid)}/participant`,
			{
				method: "DELETE",
				body: JSON.stringify({ address: handle }),
			},
		);
	}

	/**
	 * Renames a group chat
	 */
	async renameGroupChat(chatGuid: string, newName: string): Promise<void> {
		await this.request(
			`${API_ENDPOINTS.CHAT_INFO}/${encodeURIComponent(chatGuid)}`,
			{
				method: "PUT",
				body: JSON.stringify({ displayName: newName }),
			},
		);
	}
}
