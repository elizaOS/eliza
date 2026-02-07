import type { Content } from "@elizaos/core";

/**
 * Event types emitted by the Nextcloud Talk plugin.
 */
export enum NextcloudTalkEventType {
  WORLD_JOINED = "NEXTCLOUD_TALK_WORLD_JOINED",
  WORLD_CONNECTED = "NEXTCLOUD_TALK_WORLD_CONNECTED",
  WORLD_LEFT = "NEXTCLOUD_TALK_WORLD_LEFT",
  MESSAGE_RECEIVED = "NEXTCLOUD_TALK_MESSAGE_RECEIVED",
  MESSAGE_SENT = "NEXTCLOUD_TALK_MESSAGE_SENT",
  REACTION_RECEIVED = "NEXTCLOUD_TALK_REACTION_RECEIVED",
  REACTION_SENT = "NEXTCLOUD_TALK_REACTION_SENT",
  WEBHOOK_RECEIVED = "NEXTCLOUD_TALK_WEBHOOK_RECEIVED",
}

/**
 * Room/chat types in Nextcloud Talk.
 */
export enum NextcloudTalkRoomType {
  ONE_TO_ONE = "one-to-one",
  GROUP = "group",
  PUBLIC = "public",
  CHANGELOG = "changelog",
}

/**
 * Actor in the activity (the message sender).
 */
export interface NextcloudTalkActor {
  type: "Person";
  /** User ID in Nextcloud. */
  id: string;
  /** Display name of the user. */
  name: string;
}

/**
 * The message object in the activity.
 */
export interface NextcloudTalkObject {
  type: "Note";
  /** Message ID. */
  id: string;
  /** Message text (same as content for text/plain). */
  name: string;
  /** Message content. */
  content: string;
  /** Media type of the content. */
  mediaType: string;
}

/**
 * Target conversation/room.
 */
export interface NextcloudTalkTarget {
  type: "Collection";
  /** Room token. */
  id: string;
  /** Room display name. */
  name: string;
}

/**
 * Incoming webhook payload from Nextcloud Talk (Activity Streams 2.0 format).
 */
export interface NextcloudTalkWebhookPayload {
  type: "Create" | "Update" | "Delete";
  actor: NextcloudTalkActor;
  object: NextcloudTalkObject;
  target: NextcloudTalkTarget;
}

/**
 * Headers sent by Nextcloud Talk webhook.
 */
export interface NextcloudTalkWebhookHeaders {
  /** HMAC-SHA256 signature of the request. */
  signature: string;
  /** Random string used in signature calculation. */
  random: string;
  /** Backend Nextcloud server URL. */
  backend: string;
}

/**
 * Result from sending a message to Nextcloud Talk.
 */
export interface NextcloudTalkSendResult {
  messageId: string;
  roomToken: string;
  timestamp?: number;
}

/**
 * Parsed incoming message context.
 */
export interface NextcloudTalkInboundMessage {
  messageId: string;
  roomToken: string;
  roomName: string;
  senderId: string;
  senderName: string;
  text: string;
  mediaType: string;
  timestamp: number;
  isGroupChat: boolean;
}

/**
 * User information in Nextcloud Talk.
 */
export interface NextcloudTalkUser {
  id: string;
  displayName: string;
  actorType?: string;
}

/**
 * Room/conversation information.
 */
export interface NextcloudTalkRoom {
  token: string;
  name: string;
  displayName: string;
  type: NextcloudTalkRoomType;
  participantCount?: number;
  lastActivity?: number;
}

/**
 * Content with Nextcloud Talk specific fields.
 */
export interface NextcloudTalkContent extends Content {
  roomToken?: string;
  replyTo?: string;
  reaction?: string;
}

/**
 * Message payload for events.
 */
export interface NextcloudTalkMessagePayload {
  messageId: string;
  room: NextcloudTalkRoom;
  fromUser: NextcloudTalkUser | null;
  text: string | null;
  timestamp: number;
  isGroupChat: boolean;
}

/**
 * Reaction payload for events.
 */
export interface NextcloudTalkReactionPayload {
  messageId: string;
  room: NextcloudTalkRoom;
  fromUser: NextcloudTalkUser | null;
  reaction: string;
  timestamp: number;
}

/**
 * World/room context payload.
 */
export interface NextcloudTalkWorldPayload {
  room: NextcloudTalkRoom;
  botUserId?: string;
}

/**
 * Options for sending a message.
 */
export interface NextcloudTalkSendOptions {
  baseUrl: string;
  secret: string;
  roomToken: string;
  message: string;
  replyTo?: string;
}

/**
 * Options for the webhook server.
 */
export interface NextcloudTalkWebhookServerOptions {
  port: number;
  host: string;
  path: string;
  secret: string;
  onMessage: (message: NextcloudTalkInboundMessage) => void | Promise<void>;
  onError?: (error: Error) => void;
  abortSignal?: AbortSignal;
}
