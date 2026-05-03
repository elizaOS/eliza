/**
 * LINE Channel Types
 *
 * Type definitions for LINE messaging channel data structures.
 *
 * @module line/types
 */

// Constants
export const LINE_SERVICE_NAME = "line" as const;
export const MAX_LINE_BATCH_SIZE = 5;

// Event types
export const LineEventTypes = {
  CONNECTION_READY: "line:connection_ready",
  MESSAGE_RECEIVED: "line:message_received",
  MESSAGE_SENT: "line:message_sent",
  FOLLOW: "line:follow",
  UNFOLLOW: "line:unfollow",
  JOIN_GROUP: "line:join_group",
  LEAVE_GROUP: "line:leave_group",
  POSTBACK: "line:postback",
} as const;

// Error classes
export class LineConfigurationError extends Error {
  constructor(
    message: string,
    public field?: string
  ) {
    super(message);
    this.name = "LineConfigurationError";
  }
}

export class LineApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = "LineApiError";
  }
}

// Configuration types
export interface LineSettings {
  channelAccessToken: string;
  channelSecret: string;
  webhookPath: string;
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  groupPolicy: "open" | "allowlist" | "disabled";
  allowFrom: string[];
  enabled: boolean;
}

// User/Group types
export interface LineUser {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  statusMessage?: string;
  language?: string;
}

export interface LineGroup {
  groupId: string;
  groupName?: string;
  pictureUrl?: string;
  memberCount?: number;
  type: "group" | "room";
}

// Send result type
export interface LineSendResult {
  success: boolean;
  messageId?: string;
  chatId?: string;
  error?: string;
}

// Message send options
export interface LineMessageSendOptions {
  quickReplyItems?: LineQuickReplyItem[];
  notificationDisabled?: boolean;
}

// Service interface
export interface ILineService {
  isConnected(): boolean;
  sendMessage(to: string, text: string, options?: LineMessageSendOptions): Promise<LineSendResult>;
  sendFlexMessage(to: string, flex: LineFlexMessage): Promise<LineSendResult>;
  sendTemplateMessage(to: string, template: LineTemplateMessage): Promise<LineSendResult>;
  sendLocationMessage(to: string, location: LineLocationMessage): Promise<LineSendResult>;
  replyMessage(
    replyToken: string,
    messages: Array<{ type: string; [key: string]: unknown }>
  ): Promise<LineSendResult>;
  getUserProfile(userId: string): Promise<LineUser | null>;
  getGroupInfo(groupId: string): Promise<LineGroup | null>;
  getBotInfo(): Promise<LineUser | null>;
}

// Validation helpers
export function isValidLineId(id: string): boolean {
  if (!id || typeof id !== "string") {
    return false;
  }
  // LINE user IDs start with U, group IDs with C, room IDs with R
  const prefixes = ["U", "u", "C", "c", "R", "r"];
  return prefixes.some((p) => id.startsWith(p)) && id.length >= 30;
}

export function normalizeLineTarget(target: string): string | null {
  if (!target || typeof target !== "string") {
    return null;
  }
  const trimmed = target.trim();
  if (isValidLineId(trimmed)) {
    return trimmed;
  }
  return null;
}

/**
 * LINE location message data.
 */
export interface LineLocationData {
  title: string;
  address: string;
  latitude: number;
  longitude: number;
}

/**
 * LINE template action types.
 */
export type LineActionType = "message" | "postback" | "uri";

/**
 * LINE template action.
 */
export interface LineTemplateAction {
  type: LineActionType;
  label: string;
  data?: string;
  uri?: string;
}

/**
 * LINE template message base.
 */
export interface LineTemplateMessageBase {
  altText: string;
}

/**
 * LINE confirm template content.
 */
export interface LineConfirmTemplateContent {
  type: "confirm";
  text: string;
  actions: LineTemplateAction[];
}

/**
 * LINE buttons template content.
 */
export interface LineButtonsTemplateContent {
  type: "buttons";
  title?: string;
  text: string;
  thumbnailImageUrl?: string;
  actions: LineTemplateAction[];
}

/**
 * LINE template content union type.
 */
export type LineTemplateContent = LineConfirmTemplateContent | LineButtonsTemplateContent;

/**
 * LINE template message (wrapper for sending).
 */
export interface LineTemplateMessage extends LineTemplateMessageBase {
  /** The template content */
  template: LineTemplateContent;
}

/**
 * LINE Flex Message content (simplified).
 */
export interface LineFlexContents {
  type: string;
  [key: string]: unknown;
}

/**
 * LINE Flex Message data.
 */
export interface LineFlexMessage {
  altText: string;
  contents: LineFlexContents;
}

/**
 * LINE quick reply item.
 */
export interface LineQuickReplyItem {
  type: "action";
  action: {
    type: "message" | "postback";
    label: string;
    text?: string;
    data?: string;
  };
}

/**
 * LINE channel-specific data embedded in reply payloads.
 */
export interface LineChannelData {
  /** Quick reply options (text strings converted to quick reply items) */
  quickReplies?: string[];
  /** Location message */
  location?: LineLocationData;
  /** Template message (confirm, buttons, etc.) */
  templateMessage?: LineTemplateMessage;
  /** Flex message for rich content */
  flexMessage?: LineFlexMessage;
  /** Raw sticker data */
  sticker?: { packageId: string; stickerId: string };
  /** Image map message */
  imagemap?: unknown;
}

/**
 * LINE message common properties.
 */
export interface LineMessageBase {
  /** Message type */
  type: string;
  /** Quick reply */
  quickReply?: { items: LineQuickReplyItem[] };
}

/**
 * LINE text message.
 */
export interface LineTextMessage extends LineMessageBase {
  type: "text";
  text: string;
}

/**
 * LINE image message.
 */
export interface LineImageMessage extends LineMessageBase {
  type: "image";
  originalContentUrl: string;
  previewImageUrl: string;
}

/**
 * LINE sticker message.
 */
export interface LineStickerMessage extends LineMessageBase {
  type: "sticker";
  packageId: string;
  stickerId: string;
}

/**
 * LINE location message.
 */
export interface LineLocationMessage extends LineMessageBase {
  type: "location";
  title: string;
  address: string;
  latitude: number;
  longitude: number;
}

/**
 * LINE Flex message for sending.
 */
export interface LineFlexMessageSend extends LineMessageBase {
  type: "flex";
  altText: string;
  contents: LineFlexContents;
}

/**
 * LINE template message for sending.
 */
export interface LineTemplateMessageSend extends LineMessageBase {
  type: "template";
  altText: string;
  template: unknown;
}

/**
 * Union type of all LINE message types for sending.
 */
export type LineSendMessage =
  | LineTextMessage
  | LineImageMessage
  | LineStickerMessage
  | LineLocationMessage
  | LineFlexMessageSend
  | LineTemplateMessageSend;

/**
 * LINE received message type (from webhook events).
 */
export interface LineMessage {
  /** Unique message ID */
  id: string;
  /** Message type */
  type:
    | "text"
    | "image"
    | "sticker"
    | "location"
    | "flex"
    | "template"
    | "video"
    | "audio"
    | "file";
  /** User ID of the sender */
  userId: string;
  /** Message timestamp */
  timestamp: number;
  /** Reply token for responding to this message */
  replyToken?: string;
  /** Text content (for text messages) */
  text?: string;
  /** Mention data (for text messages) */
  mention?: unknown;
  /** Group ID (if message is from a group) */
  groupId?: string;
  /** Room ID (if message is from a room) */
  roomId?: string;
}

/**
 * LINE chat type: user, group, or room.
 */
export type LineChatType = "user" | "group" | "room";

/**
 * Determines the chat type from a LINE ID.
 */
export function getChatTypeFromId(id: string): LineChatType {
  if (id.startsWith("C") || id.startsWith("c")) {
    return "group";
  } else if (id.startsWith("R") || id.startsWith("r")) {
    return "room";
  }
  return "user";
}

/**
 * LINE message character limit (5000 characters per message).
 */
const LINE_MAX_MESSAGE_LENGTH = 5000;

/**
 * Splits text into chunks that fit within LINE's message limit.
 */
export function splitMessageForLine(text: string): string[] {
  if (!text || text.length === 0) {
    return [];
  }

  if (text.length <= LINE_MAX_MESSAGE_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= LINE_MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at the last newline or space before the limit
    let splitIndex = LINE_MAX_MESSAGE_LENGTH;
    const lastNewline = remaining.lastIndexOf("\n", LINE_MAX_MESSAGE_LENGTH);
    const lastSpace = remaining.lastIndexOf(" ", LINE_MAX_MESSAGE_LENGTH);

    if (lastNewline > LINE_MAX_MESSAGE_LENGTH / 2) {
      splitIndex = lastNewline + 1;
    } else if (lastSpace > LINE_MAX_MESSAGE_LENGTH / 2) {
      splitIndex = lastSpace + 1;
    }

    chunks.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex);
  }

  return chunks.filter(Boolean);
}
