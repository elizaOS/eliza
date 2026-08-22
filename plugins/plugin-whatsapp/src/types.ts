/**
 * Raw types for the direct in-process Baileys transport, including outbound
 * messages, normalized inbound messages, connection status, and QR state.
 */
export type WhatsAppConfig = BaileysConfig;

export interface BaileysConfig {
  authMethod?: "baileys";
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
  | "sticker"
  | "location"
  | "contacts"
  | "interactive"
  | "reaction";

export interface WhatsAppMessage {
  type: WhatsAppMessageType;
  to: string;
  content:
    | string
    | WhatsAppTemplate
    | WhatsAppMediaMessage
    | WhatsAppInteractiveMessage
    | WhatsAppReactionMessage
    | WhatsAppLocationMessage;
  replyToMessageId?: string;
}

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
      image?: { link: string };
      document?: { link: string; filename?: string };
      video?: { link: string };
    }>;
  }>;
}

/**
 * Media message content.
 */
export interface WhatsAppMediaMessage {
  link?: string;
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

/**
 * Location message content.
 */
export interface WhatsAppLocationMessage {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

/**
 * Interactive message types.
 */
export type InteractiveMessageType = "button" | "list" | "product" | "product_list" | "flow";

/**
 * Interactive message content.
 */
export interface WhatsAppInteractiveMessage {
  type: InteractiveMessageType;
  header?: {
    type: "text" | "image" | "video" | "document";
    text?: string;
    image?: { link: string };
    video?: { link: string };
    document?: { link: string; filename?: string };
  };
  body: {
    text: string;
  };
  footer?: {
    text: string;
  };
  action: WhatsAppInteractiveAction;
}

/**
 * Interactive action based on message type.
 */
export type WhatsAppInteractiveAction =
  | WhatsAppButtonAction
  | WhatsAppListAction
  | WhatsAppFlowAction;

/**
 * Button action for interactive messages.
 */
export interface WhatsAppButtonAction {
  buttons: Array<{
    type: "reply";
    reply: {
      id: string;
      title: string;
    };
  }>;
}

/**
 * List action for interactive messages.
 */
export interface WhatsAppListAction {
  button: string;
  sections: Array<{
    title?: string;
    rows: Array<{
      id: string;
      title: string;
      description?: string;
    }>;
  }>;
}

/**
 * Flow action for interactive messages.
 */
export interface WhatsAppFlowAction {
  name: "flow";
  parameters: {
    flow_message_version: string;
    flow_token: string;
    flow_id: string;
    flow_cta: string;
    flow_action: "navigate" | "data_exchange";
    flow_action_payload?: {
      screen: string;
      data?: Record<string, unknown>;
    };
  };
}

export interface WhatsAppMessageResponse {
  messaging_product: string;
  contacts: Array<{
    input: string;
    wa_id: string;
  }>;
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

/**
 * Send reaction parameters.
 */
export interface SendReactionParams {
  to: string;
  messageId: string;
  emoji: string;
}

/**
 * Send reaction result.
 */
export interface SendReactionResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * WhatsApp event types.
 */
export enum WhatsAppEventType {
  MESSAGE_RECEIVED = "WHATSAPP_MESSAGE_RECEIVED",
  MESSAGE_SENT = "WHATSAPP_MESSAGE_SENT",
  MESSAGE_DELIVERED = "WHATSAPP_MESSAGE_DELIVERED",
  MESSAGE_READ = "WHATSAPP_MESSAGE_READ",
  MESSAGE_FAILED = "WHATSAPP_MESSAGE_FAILED",
  REACTION_RECEIVED = "WHATSAPP_REACTION_RECEIVED",
  REACTION_SENT = "WHATSAPP_REACTION_SENT",
  INTERACTIVE_REPLY = "WHATSAPP_INTERACTIVE_REPLY",
}

/**
 * Common WhatsApp reaction emojis.
 */
export const WHATSAPP_REACTIONS = {
  THUMBS_UP: "👍",
  THUMBS_DOWN: "👎",
  HEART: "❤️",
  LAUGHING: "😂",
  SURPRISED: "😮",
  SAD: "😢",
  PRAYING: "🙏",
  CLAPPING: "👏",
  FIRE: "🔥",
  CELEBRATION: "🎉",
} as const;

export type WhatsAppReactionEmoji = (typeof WHATSAPP_REACTIONS)[keyof typeof WHATSAPP_REACTIONS];
