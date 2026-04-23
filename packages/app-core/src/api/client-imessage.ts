import { ElizaClient } from "./client-base";

export interface IMessageApiStatus {
  available: boolean;
  connected: boolean;
  chatDbAvailable?: boolean;
  sendOnly?: boolean;
  chatDbPath?: string;
  reason?: string | null;
  permissionAction?: {
    type: "full_disk_access";
    label: string;
    url: string;
    instructions: string[];
  } | null;
}

export interface IMessageApiMessage {
  id: string;
  text: string;
  handle: string;
  chatId: string;
  timestamp: number;
  isFromMe: boolean;
  hasAttachments: boolean;
  attachmentPaths?: string[];
}

export interface IMessageApiChat {
  chatId: string;
  chatType: "direct" | "group";
  displayName?: string;
  participants: Array<{
    handle: string;
    isPhoneNumber: boolean;
  }>;
}

export interface GetIMessageMessagesOptions {
  chatId?: string;
  limit?: number;
}

export interface SendIMessageRequest {
  to?: string;
  chatId?: string;
  text?: string;
  mediaUrl?: string;
  maxBytes?: number;
}

export interface SendIMessageResponse {
  success: boolean;
  messageId?: string;
  chatId?: string;
  error?: string;
}

declare module "./client-base" {
  interface ElizaClient {
    getIMessageStatus(): Promise<IMessageApiStatus>;
    getIMessageMessages(
      options?: GetIMessageMessagesOptions,
    ): Promise<{ messages: IMessageApiMessage[]; count: number }>;
    listIMessageChats(): Promise<{ chats: IMessageApiChat[]; count: number }>;
    sendIMessage(request: SendIMessageRequest): Promise<SendIMessageResponse>;
  }
}

function buildQuery(params: URLSearchParams): string {
  const query = params.toString();
  return query.length > 0 ? `?${query}` : "";
}

ElizaClient.prototype.getIMessageStatus = async function (this: ElizaClient) {
  return this.fetch("/api/imessage/status");
};

ElizaClient.prototype.getIMessageMessages = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  if (options.chatId?.trim()) {
    params.set("chatId", options.chatId.trim());
  }
  if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
    params.set("limit", String(options.limit));
  }
  return this.fetch(`/api/imessage/messages${buildQuery(params)}`);
};

ElizaClient.prototype.listIMessageChats = async function (this: ElizaClient) {
  return this.fetch("/api/imessage/chats");
};

ElizaClient.prototype.sendIMessage = async function (
  this: ElizaClient,
  request,
) {
  return this.fetch("/api/imessage/messages", {
    method: "POST",
    body: JSON.stringify(request),
  });
};
