import { ElizaClient } from "./client-base";

export interface IMessageApiStatus {
  available: boolean;
  connected: boolean;
  bridgeType?: "native" | "imsg" | "bluebubbles" | "none";
  hostPlatform?: "darwin" | "linux" | "win32" | "unknown";
  diagnostics?: string[];
  error?: string | null;
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
  to: string;
  text: string;
  attachmentPaths?: string[];
  mediaUrl?: string;
}

export interface SendIMessageResponse {
  success: boolean;
  messageId?: string;
  chatId?: string;
  error?: string;
}

interface LifeOpsIMessageStatusResponse extends IMessageApiStatus {
  lastSyncAt?: string | null;
  lastCheckedAt?: string | null;
}

interface LifeOpsIMessageMessageResponse {
  id: string;
  fromHandle: string;
  toHandles: string[];
  text: string;
  isFromMe: boolean;
  sentAt: string;
  chatId?: string;
  attachments?: Array<{ path?: string }>;
}

interface LifeOpsIMessageChatResponse {
  id: string;
  name: string;
  participants: string[];
  lastMessageAt?: string;
}

interface LifeOpsIMessageSendResponse {
  ok: boolean;
  messageId?: string;
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
  return this.fetch<LifeOpsIMessageStatusResponse>(
    "/api/lifeops/connectors/imessage/status",
  );
};

function normalizeLifeOpsMessage(
  message: LifeOpsIMessageMessageResponse,
): IMessageApiMessage {
  const attachmentPaths =
    message.attachments
      ?.map((attachment) => attachment.path)
      .filter((path): path is string => typeof path === "string") ?? [];

  return {
    id: message.id,
    text: message.text,
    handle: message.isFromMe
      ? (message.toHandles[0] ?? "")
      : message.fromHandle,
    chatId: message.chatId ?? "",
    timestamp: Date.parse(message.sentAt) || 0,
    isFromMe: message.isFromMe,
    hasAttachments: attachmentPaths.length > 0,
    ...(attachmentPaths.length > 0 ? { attachmentPaths } : {}),
  };
}

function normalizeLifeOpsChat(
  chat: LifeOpsIMessageChatResponse,
): IMessageApiChat {
  return {
    chatId: chat.id,
    chatType: chat.participants.length > 1 ? "group" : "direct",
    displayName: chat.name,
    participants: chat.participants.map((handle) => ({
      handle,
      isPhoneNumber: /^\+?[0-9()\s.-]+$/.test(handle),
    })),
  };
}

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
  const result = await this.fetch<{
    messages: LifeOpsIMessageMessageResponse[];
    count: number;
  }>(`/api/lifeops/connectors/imessage/messages${buildQuery(params)}`);
  return {
    messages: result.messages.map(normalizeLifeOpsMessage),
    count: result.count,
  };
};

ElizaClient.prototype.listIMessageChats = async function (this: ElizaClient) {
  const result = await this.fetch<{
    chats: LifeOpsIMessageChatResponse[];
    count: number;
  }>("/api/lifeops/connectors/imessage/chats");
  return {
    chats: result.chats.map(normalizeLifeOpsChat),
    count: result.count,
  };
};

ElizaClient.prototype.sendIMessage = async function (
  this: ElizaClient,
  request,
) {
  const attachmentPaths =
    request.attachmentPaths ??
    (request.mediaUrl ? [request.mediaUrl] : undefined);
  const body = {
    to: request.to,
    text: request.text,
    ...(attachmentPaths ? { attachmentPaths } : {}),
  };
  const result = await this.fetch<LifeOpsIMessageSendResponse>(
    "/api/lifeops/connectors/imessage/send",
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
  return {
    success: result.ok,
    messageId: result.messageId,
  };
};
