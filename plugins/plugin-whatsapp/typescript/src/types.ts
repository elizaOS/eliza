export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  webhookVerifyToken?: string;
  businessAccountId?: string;
  apiVersion?: string;
}

/**
 * Message types supported by WhatsApp Cloud API.
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

export interface WhatsAppIncomingMessage {
  from: string;
  id: string;
  timestamp: string;
  text?: {
    body: string;
  };
  image?: {
    caption?: string;
    mime_type: string;
    sha256: string;
    id: string;
  };
  video?: {
    caption?: string;
    mime_type: string;
    sha256: string;
    id: string;
  };
  audio?: {
    mime_type: string;
    sha256: string;
    id: string;
    voice?: boolean;
  };
  document?: {
    caption?: string;
    filename: string;
    mime_type: string;
    sha256: string;
    id: string;
  };
  sticker?: {
    mime_type: string;
    sha256: string;
    id: string;
    animated?: boolean;
  };
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  contacts?: Array<{
    name: {
      formatted_name: string;
      first_name?: string;
      last_name?: string;
    };
    phones?: Array<{
      phone: string;
      type: string;
    }>;
  }>;
  interactive?: {
    type: "button_reply" | "list_reply" | "nfm_reply";
    button_reply?: {
      id: string;
      title: string;
    };
    list_reply?: {
      id: string;
      title: string;
      description?: string;
    };
    nfm_reply?: {
      response_json: string;
      body: string;
      name: string;
    };
  };
  reaction?: {
    message_id: string;
    emoji: string;
  };
  context?: {
    from: string;
    id: string;
    referred_product?: {
      catalog_id: string;
      product_retailer_id: string;
    };
  };
  type: string;
}

export interface WhatsAppStatusUpdate {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  recipient_id: string;
  conversation?: {
    id: string;
    origin?: {
      type: string;
    };
    expiration_timestamp?: string;
  };
  pricing?: {
    billable: boolean;
    pricing_model: string;
    category: string;
  };
  errors?: Array<{
    code: number;
    title: string;
    message?: string;
    error_data?: {
      details: string;
    };
  }>;
}

export interface WhatsAppWebhookEvent {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: {
          display_phone_number: string;
          phone_number_id: string;
        };
        statuses?: WhatsAppStatusUpdate[];
        messages?: WhatsAppIncomingMessage[];
        contacts?: Array<{
          profile: {
            name: string;
          };
          wa_id: string;
        }>;
        errors?: Array<{
          code: number;
          title: string;
          message?: string;
          error_data?: {
            details: string;
          };
        }>;
      };
      field: string;
    }>;
  }>;
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
  WEBHOOK_VERIFIED = "WHATSAPP_WEBHOOK_VERIFIED",
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
