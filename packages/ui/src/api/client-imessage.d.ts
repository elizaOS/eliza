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
declare module "./client-base" {
  interface ElizaClient {
    getIMessageStatus(): Promise<IMessageApiStatus>;
    getIMessageMessages(options?: GetIMessageMessagesOptions): Promise<{
      messages: IMessageApiMessage[];
      count: number;
    }>;
    listIMessageChats(): Promise<{
      chats: IMessageApiChat[];
      count: number;
    }>;
    sendIMessage(request: SendIMessageRequest): Promise<SendIMessageResponse>;
  }
}
//# sourceMappingURL=client-imessage.d.ts.map
