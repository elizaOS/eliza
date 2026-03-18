import type { UUID } from "@elizaos/core";

/**
 * Supported messaging channels.
 */
export type MessagingChannel =
  | "discord"
  | "telegram"
  | "slack"
  | "whatsapp"
  | "twitch"
  | "google_chat"
  | "internal"
  | "unknown";

/**
 * Target specification for sending a message.
 */
export interface MessageTarget {
  /** The channel/platform to send to */
  channel: MessagingChannel;
  /** The recipient/chat/channel ID */
  to: string;
  /** Optional account ID for multi-account setups */
  accountId?: string;
  /** Optional thread ID for threaded conversations */
  threadId?: string | number;
  /** Optional message to reply to */
  replyToMessageId?: string;
}

/**
 * Message content to send.
 */
export interface MessageContent {
  /** Text content */
  text: string;
  /** Optional attachments */
  attachments?: MessageAttachment[];
  /** Optional embed/card data */
  embed?: MessageEmbed;
  /** Optional inline buttons/actions */
  buttons?: MessageButton[];
  /** Whether to disable link previews */
  disableLinkPreview?: boolean;
  /** Whether to send silently (no notification) */
  silent?: boolean;
}

/**
 * Attachment to include with a message.
 */
export interface MessageAttachment {
  /** Type of attachment */
  type: "image" | "video" | "audio" | "file" | "sticker";
  /** URL to the attachment */
  url?: string;
  /** Local file path */
  path?: string;
  /** Base64 encoded data */
  data?: string;
  /** Filename */
  filename?: string;
  /** MIME type */
  mimeType?: string;
  /** Caption for the attachment */
  caption?: string;
}

/**
 * Embed/card data for rich messages.
 */
export interface MessageEmbed {
  /** Title of the embed */
  title?: string;
  /** Description text */
  description?: string;
  /** URL the title links to */
  url?: string;
  /** Color (hex string or number) */
  color?: string | number;
  /** Thumbnail image URL */
  thumbnailUrl?: string;
  /** Main image URL */
  imageUrl?: string;
  /** Footer text */
  footer?: string;
  /** Fields/key-value pairs */
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  /** Timestamp */
  timestamp?: Date | string | number;
}

/**
 * Button/action for interactive messages.
 */
export interface MessageButton {
  /** Button label */
  label: string;
  /** Button type */
  type: "url" | "callback" | "action";
  /** URL for url buttons */
  url?: string;
  /** Callback data for callback buttons */
  data?: string;
  /** Action to trigger */
  action?: string;
  /** Optional emoji */
  emoji?: string;
}

/**
 * Parameters for sending a message.
 */
export interface SendMessageParams {
  /** Target to send to */
  target: MessageTarget;
  /** Content to send */
  content: MessageContent;
  /** Idempotency key to prevent duplicate sends */
  idempotencyKey?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Result of sending a message.
 */
export interface SendMessageResult {
  /** Whether the send was successful */
  success: boolean;
  /** ID of the sent message */
  messageId?: string;
  /** Channel the message was sent to */
  channel: MessagingChannel;
  /** Target ID */
  targetId: string;
  /** Error message if failed */
  error?: string;
  /** Timestamp when sent */
  sentAt?: number;
}

/**
 * Message delivery status.
 */
export interface DeliveryStatus {
  /** Current status */
  status: "pending" | "sent" | "delivered" | "read" | "failed";
  /** Message ID */
  messageId?: string;
  /** When status was last updated */
  updatedAt: number;
  /** Error if failed */
  error?: string;
}

/**
 * Adapter interface for platform-specific messaging.
 * Each platform plugin should implement this interface.
 */
export interface MessagingAdapter {
  /** Channel this adapter handles */
  channel: MessagingChannel;

  /** Whether the adapter is currently available (may be async when checking runtime services) */
  isAvailable(): boolean | Promise<boolean>;

  /** Send a message */
  send(params: SendMessageParams): Promise<SendMessageResult>;

  /** Check delivery status (if supported) */
  getDeliveryStatus?(messageId: string): Promise<DeliveryStatus | null>;

  /** Delete a message (if supported) */
  deleteMessage?(messageId: string, targetId: string): Promise<boolean>;

  /** Edit a message (if supported) */
  editMessage?(
    messageId: string,
    targetId: string,
    content: MessageContent,
  ): Promise<SendMessageResult>;
}

/**
 * Events emitted by the messaging service.
 */
export const MessagingEventType = {
  /** Message send requested */
  SEND_REQUESTED: "MESSAGING_SEND_REQUESTED",
  /** Message sent successfully */
  SENT: "MESSAGING_SENT",
  /** Message send failed */
  SEND_FAILED: "MESSAGING_SEND_FAILED",
  /** Message delivered */
  DELIVERED: "MESSAGING_DELIVERED",
  /** Message read */
  READ: "MESSAGING_READ",
} as const;

export type MessagingEventType =
  (typeof MessagingEventType)[keyof typeof MessagingEventType];

/**
 * Payload for messaging events.
 */
export interface MessagingEventPayload {
  idempotencyKey?: string;
  messageId?: string;
  channel: MessagingChannel;
  targetId: string;
  status: DeliveryStatus["status"];
  error?: string;
  sentAt?: number;
}

/**
 * Room metadata for messaging routing.
 */
export interface MessagingRoomMetadata {
  /** Primary messaging channel for this room */
  messagingChannel?: MessagingChannel;
  /** Primary recipient ID for this room */
  messagingTo?: string;
  /** Account ID for multi-account setups */
  messagingAccountId?: string;
  /** Thread ID for threaded conversations */
  messagingThreadId?: string | number;
}
