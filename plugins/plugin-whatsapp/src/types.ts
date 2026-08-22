/**
 * Raw types for the direct in-process Baileys transport, including outbound
 * messages, normalized inbound messages, connection status, and QR state.
 */
export interface BaileysConfig {
  authDir: string;
  printQRInTerminal?: boolean;
}

/**
 * Message types supported by the connector.
 */
export type WhatsAppMessageType =
  | "text"
  | "template"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "reaction";

interface WhatsAppMessageBase {
  to: string;
  replyToMessageId?: string;
}

export type WhatsAppMessage =
  | (WhatsAppMessageBase & { type: "text"; content: string })
  | (WhatsAppMessageBase & { type: "template"; content: WhatsAppTemplate })
  | (WhatsAppMessageBase & {
      type: "image" | "audio" | "video" | "document";
      content: WhatsAppMediaMessage;
    })
  | (WhatsAppMessageBase & { type: "reaction"; content: WhatsAppReactionMessage });

export interface WhatsAppTemplate {
  name: string;
  language: {
    code: string;
  };
  components?: Array<{
    type: string;
    parameters: Array<{
      type: string;
      text?: string;
    }>;
  }>;
}

/**
 * Media message content.
 */
export interface WhatsAppMediaMessage {
  /** Guarded, size-capped bytes staged by the runtime before Baileys dispatch. */
  data?: Uint8Array;
  id?: string;
  caption?: string;
  filename?: string;
  mimeType?: string;
}

/**
 * Reaction message content.
 */
export interface WhatsAppReactionMessage {
  messageId: string;
  emoji: string;
}

export interface WhatsAppMessageResponse {
  messages: Array<{
    id: string;
    message_status?: string;
  }>;
}

export interface QRCodeData {
  terminal: string;
  dataURL: string;
  raw: string;
}

export type ConnectionStatus = "connecting" | "open" | "close";

export interface NormalizedMessage {
  id: string;
  from: string;
  timestamp: number;
  type: "text" | "image" | "audio" | "video" | "document";
  content: string;
  chatId?: string;
  senderId?: string;
  replyToId?: string;
}
