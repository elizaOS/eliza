import type { Content, MessagePayload } from "@elizaos/core";

/**
 * Zalo message content extension
 */
export interface ZaloContent extends Content {
  /** Image URL for media messages */
  imageUrl?: string;
  /** Image caption */
  caption?: string;
}

/**
 * Event types emitted by the Zalo plugin
 */
export enum ZaloEventTypes {
  BOT_STARTED = "ZALO_BOT_STARTED",
  BOT_STOPPED = "ZALO_BOT_STOPPED",
  MESSAGE_RECEIVED = "ZALO_MESSAGE_RECEIVED",
  MESSAGE_SENT = "ZALO_MESSAGE_SENT",
  WEBHOOK_REGISTERED = "ZALO_WEBHOOK_REGISTERED",
  USER_FOLLOWED = "ZALO_USER_FOLLOWED",
  USER_UNFOLLOWED = "ZALO_USER_UNFOLLOWED",
  TOKEN_REFRESHED = "ZALO_TOKEN_REFRESHED",
}

/**
 * Zalo user information
 */
export interface ZaloUser {
  /** Zalo user ID */
  id: string;
  /** User display name */
  name?: string;
  /** User avatar URL */
  avatar?: string;
}

/**
 * Zalo chat information (always DM for OA)
 */
export interface ZaloChat {
  /** Chat/user ID */
  id: string;
  /** Chat type (always "PRIVATE" for OA) */
  chatType: "PRIVATE";
}

/**
 * Zalo message structure
 */
export interface ZaloMessage {
  /** Message ID */
  messageId: string;
  /** Sender information */
  from: ZaloUser;
  /** Chat information */
  chat: ZaloChat;
  /** Message timestamp (Unix seconds) */
  date: number;
  /** Text content */
  text?: string;
  /** Image URL */
  photo?: string;
  /** Image caption */
  caption?: string;
  /** Sticker ID */
  sticker?: string;
}

/**
 * Zalo webhook update event
 */
export interface ZaloUpdate {
  /** Event name */
  eventName:
    | "message.text.received"
    | "message.image.received"
    | "message.sticker.received"
    | "message.unsupported.received"
    | "follow"
    | "unfollow";
  /** Message data (for message events) */
  message?: ZaloMessage;
  /** User ID (for follow/unfollow events) */
  userId?: string;
  /** Event timestamp */
  timestamp?: number;
}

/**
 * Zalo API response wrapper
 */
export interface ZaloApiResponse<T = unknown> {
  /** Error code (0 for success) */
  error: number;
  /** Error message */
  message: string;
  /** Response data */
  data?: T;
}

/**
 * Zalo OA info returned by getMe
 */
export interface ZaloOAInfo {
  /** OA ID */
  oaId: string;
  /** OA name */
  name: string;
  /** OA description */
  description?: string;
  /** OA avatar URL */
  avatar?: string;
  /** OA cover URL */
  cover?: string;
}

/**
 * Parameters for sending a text message
 */
export interface ZaloSendMessageParams {
  /** Recipient user ID */
  userId: string;
  /** Message text */
  text: string;
}

/**
 * Parameters for sending an image message
 */
export interface ZaloSendImageParams {
  /** Recipient user ID */
  userId: string;
  /** Image URL */
  imageUrl: string;
  /** Optional caption */
  caption?: string;
}

/**
 * Result of probing the Zalo OA connection
 */
export interface ZaloBotProbe {
  /** Whether the probe was successful */
  ok: boolean;
  /** OA info if successful */
  oa?: ZaloOAInfo;
  /** Error message if failed */
  error?: string;
  /** Latency in milliseconds */
  latencyMs: number;
}

/**
 * Bot status payload for start/stop events
 */
export interface ZaloBotStatusPayload {
  /** OA ID */
  oaId?: string;
  /** OA name */
  oaName?: string;
  /** Update mode (polling or webhook) */
  updateMode: "polling" | "webhook";
  /** Timestamp in milliseconds */
  timestamp: number;
}

/**
 * Webhook registration payload
 */
export interface ZaloWebhookPayload {
  /** Full webhook URL */
  url: string;
  /** Webhook path */
  path: string;
  /** Webhook port */
  port?: number;
  /** Timestamp in milliseconds */
  timestamp: number;
}

/**
 * Message received payload
 */
export interface ZaloMessageReceivedPayload extends MessagePayload {
  /** Original Zalo message */
  originalMessage: ZaloMessage;
}

/**
 * Message sent payload
 */
export interface ZaloMessageSentPayload {
  /** Recipient user ID */
  userId: string;
  /** Message ID returned by API */
  messageId?: string;
  /** Message text */
  text: string;
  /** Whether send was successful */
  success: boolean;
}

/**
 * User follow/unfollow payload
 */
export interface ZaloFollowPayload {
  /** User ID */
  userId: string;
  /** Event type */
  action: "follow" | "unfollow";
  /** Timestamp */
  timestamp: number;
}

/**
 * Zalo settings built from config
 */
export interface ZaloSettings {
  /** Zalo App ID */
  appId: string;
  /** Zalo Secret Key */
  secretKey: string;
  /** OAuth access token */
  accessToken: string;
  /** OAuth refresh token */
  refreshToken?: string;
  /** Update mode */
  updateMode: "polling" | "webhook";
  /** Webhook URL (if webhook mode) */
  webhookUrl?: string;
  /** Webhook path */
  webhookPath: string;
  /** Webhook port */
  webhookPort: number;
  /** Whether plugin is enabled */
  enabled: boolean;
  /** HTTP proxy URL */
  proxyUrl?: string;
}
