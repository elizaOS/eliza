import type {
  Content,
  EntityPayload,
  MessagePayload,
  WorldPayload,
} from "@elizaos/core";

/**
 * Zalo User plugin content extension.
 */
export interface ZaloUserContent extends Content {
  /** Optional buttons for interactive messages */
  buttons?: ZaloButton[];
}

/**
 * Button types for Zalo messages.
 */
export type ZaloButton = {
  kind: "url" | "callback";
  text: string;
  url?: string;
  payload?: string;
};

/**
 * Event types emitted by the Zalo User plugin.
 */
export enum ZaloUserEventTypes {
  WORLD_JOINED = "ZALOUSER_WORLD_JOINED",
  WORLD_CONNECTED = "ZALOUSER_WORLD_CONNECTED",
  WORLD_LEFT = "ZALOUSER_WORLD_LEFT",
  ENTITY_JOINED = "ZALOUSER_ENTITY_JOINED",
  ENTITY_LEFT = "ZALOUSER_ENTITY_LEFT",
  ENTITY_UPDATED = "ZALOUSER_ENTITY_UPDATED",
  MESSAGE_RECEIVED = "ZALOUSER_MESSAGE_RECEIVED",
  MESSAGE_SENT = "ZALOUSER_MESSAGE_SENT",
  REACTION_RECEIVED = "ZALOUSER_REACTION_RECEIVED",
  REACTION_SENT = "ZALOUSER_REACTION_SENT",
  QR_CODE_READY = "ZALOUSER_QR_CODE_READY",
  LOGIN_SUCCESS = "ZALOUSER_LOGIN_SUCCESS",
  LOGIN_FAILED = "ZALOUSER_LOGIN_FAILED",
  CLIENT_STARTED = "ZALOUSER_CLIENT_STARTED",
  CLIENT_STOPPED = "ZALOUSER_CLIENT_STOPPED",
}

/**
 * Zalo chat/conversation type.
 */
export enum ZaloUserChatType {
  PRIVATE = "private",
  GROUP = "group",
}

/**
 * Zalo user information.
 */
export interface ZaloUser {
  /** Zalo user ID */
  id: string;
  /** Display name */
  displayName: string;
  /** Username (phone number or alias) */
  username?: string;
  /** Avatar URL */
  avatar?: string;
  /** Whether this is the authenticated user */
  isSelf?: boolean;
}

/**
 * Zalo chat/conversation information.
 */
export interface ZaloChat {
  /** Thread/conversation ID */
  threadId: string;
  /** Chat type (private or group) */
  type: ZaloUserChatType;
  /** Chat name (for groups) or participant name (for DMs) */
  name?: string;
  /** Avatar URL */
  avatar?: string;
  /** Number of members (for groups) */
  memberCount?: number;
  /** Whether this is a group chat */
  isGroup: boolean;
}

/**
 * Zalo friend entry.
 */
export interface ZaloFriend {
  /** User ID */
  userId: string;
  /** Display name */
  displayName: string;
  /** Avatar URL */
  avatar?: string;
  /** Phone number if available */
  phoneNumber?: string;
}

/**
 * Zalo group entry.
 */
export interface ZaloGroup {
  /** Group ID */
  groupId: string;
  /** Group name */
  name: string;
  /** Member count */
  memberCount?: number;
  /** Group avatar URL */
  avatar?: string;
}

/**
 * Zalo message payload.
 */
export interface ZaloMessage {
  /** Message ID */
  msgId: string;
  /** CLI message ID (internal) */
  cliMsgId?: string;
  /** Thread/conversation ID */
  threadId: string;
  /** Message type code */
  type: number;
  /** Message content */
  content: string;
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Message metadata */
  metadata?: {
    isGroup: boolean;
    threadName?: string;
    senderName?: string;
    senderId?: string;
  };
}

/**
 * Payload for message received events.
 */
export interface ZaloUserMessageReceivedPayload extends MessagePayload {
  /** Original Zalo message */
  originalMessage: ZaloMessage;
  /** Chat context */
  chat: ZaloChat;
  /** Sender info */
  sender?: ZaloUser;
}

/**
 * Payload for message sent events.
 */
export interface ZaloUserMessageSentPayload extends MessagePayload {
  /** Message ID of sent message */
  messageId?: string;
  /** Thread ID where message was sent */
  threadId: string;
}

/**
 * Payload for world/chat events.
 */
export interface ZaloUserWorldPayload extends WorldPayload {
  /** Zalo chat info */
  chat: ZaloChat;
  /** Current user info */
  currentUser?: ZaloUser;
}

/**
 * Payload for entity events.
 */
export interface ZaloUserEntityPayload extends EntityPayload {
  /** Zalo user info */
  zaloUser: ZaloUser;
}

/**
 * QR code ready payload.
 */
export interface ZaloUserQrCodePayload {
  /** Base64 encoded QR code image data URL */
  qrDataUrl?: string;
  /** Message/instructions */
  message: string;
  /** Profile being authenticated */
  profile?: string;
}

/**
 * Client status payload.
 */
export interface ZaloUserClientStatusPayload {
  /** Profile name */
  profile?: string;
  /** User info if authenticated */
  user?: ZaloUser;
  /** Whether client is running */
  running: boolean;
  /** Timestamp */
  timestamp: number;
}

/**
 * Probe result for health checks.
 */
export interface ZaloUserProbe {
  /** Whether the probe was successful */
  ok: boolean;
  /** User info if authenticated */
  user?: ZaloUser;
  /** Error message if failed */
  error?: string;
  /** Latency in milliseconds */
  latencyMs: number;
}

/**
 * Send message parameters.
 */
export interface SendMessageParams {
  /** Thread ID to send to */
  threadId: string;
  /** Message text */
  text: string;
  /** Whether this is a group message */
  isGroup?: boolean;
  /** Profile to use for multi-profile setups */
  profile?: string;
}

/**
 * Send message result.
 */
export interface SendMessageResult {
  /** Whether the send was successful */
  success: boolean;
  /** Thread ID */
  threadId: string;
  /** Message ID if successful */
  messageId?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Send media parameters.
 */
export interface SendMediaParams {
  /** Thread ID to send to */
  threadId: string;
  /** Media URL */
  mediaUrl: string;
  /** Optional caption */
  caption?: string;
  /** Whether this is a group message */
  isGroup?: boolean;
  /** Profile to use */
  profile?: string;
}

/**
 * Zalo profile configuration.
 */
export interface ZaloUserProfile {
  /** Profile name/identifier */
  name: string;
  /** Display label */
  label?: string;
  /** Whether this is the default profile */
  isDefault?: boolean;
  /** Cookie path for this profile */
  cookiePath?: string;
  /** IMEI for this profile */
  imei?: string;
  /** User agent for this profile */
  userAgent?: string;
}

/**
 * Authenticated user info.
 */
export interface ZaloUserInfo {
  /** User ID */
  userId: string;
  /** Display name */
  displayName: string;
  /** Avatar URL */
  avatar?: string;
  /** Phone number */
  phoneNumber?: string;
}
