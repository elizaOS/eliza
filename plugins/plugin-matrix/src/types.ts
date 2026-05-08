/**
 * Type definitions for the Matrix plugin.
 */

import type { IAgentRuntime, Service } from "@elizaos/core";

// ============================================================================
// Constants
// ============================================================================

/** Maximum message length for Matrix */
export const MAX_MATRIX_MESSAGE_LENGTH = 4000;

/** Service name constant */
export const MATRIX_SERVICE_NAME = "matrix";

// ============================================================================
// Event Types
// ============================================================================

/** Event types emitted by the Matrix plugin */
export enum MatrixEventTypes {
  MESSAGE_RECEIVED = "MATRIX_MESSAGE_RECEIVED",
  MESSAGE_SENT = "MATRIX_MESSAGE_SENT",
  ROOM_JOINED = "MATRIX_ROOM_JOINED",
  ROOM_LEFT = "MATRIX_ROOM_LEFT",
  INVITE_RECEIVED = "MATRIX_INVITE_RECEIVED",
  REACTION_RECEIVED = "MATRIX_REACTION_RECEIVED",
  TYPING_RECEIVED = "MATRIX_TYPING_RECEIVED",
  SYNC_COMPLETE = "MATRIX_SYNC_COMPLETE",
  CONNECTION_READY = "MATRIX_CONNECTION_READY",
  CONNECTION_LOST = "MATRIX_CONNECTION_LOST",
}

// ============================================================================
// Configuration Types
// ============================================================================

/** Configuration settings for the Matrix plugin */
export interface MatrixSettings {
  /** Connector account identifier for this Matrix bot instance */
  accountId?: string;
  /** Matrix homeserver URL */
  homeserver: string;
  /** Matrix user ID (@user:homeserver) */
  userId: string;
  /** Access token for authentication */
  accessToken: string;
  /** Device ID for this session */
  deviceId?: string;
  /** Rooms to auto-join */
  rooms: string[];
  /** Whether to auto-accept invites */
  autoJoin: boolean;
  /** Enable end-to-end encryption */
  encryption: boolean;
  /** Require mention to respond in rooms */
  requireMention: boolean;
  /** Whether this configuration is enabled */
  enabled: boolean;
}

// ============================================================================
// Message Types
// ============================================================================

/** Information about a Matrix user */
export interface MatrixUserInfo {
  /** Matrix user ID (@user:homeserver) */
  userId: string;
  /** Display name */
  displayName?: string;
  /** Avatar URL */
  avatarUrl?: string;
}

/** Represents a Matrix room */
export interface MatrixRoom {
  /** Room ID (!room:homeserver) */
  roomId: string;
  /** Room name */
  name?: string;
  /** Room topic */
  topic?: string;
  /** Room alias (#alias:homeserver) */
  canonicalAlias?: string;
  /** Whether room is encrypted */
  isEncrypted: boolean;
  /** Whether this is a direct message room */
  isDirect: boolean;
  /** Member count */
  memberCount: number;
}

/** Represents a Matrix message */
export interface MatrixMessage {
  /** Event ID */
  eventId: string;
  /** Room ID */
  roomId: string;
  /** Sender user ID */
  sender: string;
  /** Sender info */
  senderInfo: MatrixUserInfo;
  /** Message content */
  content: string;
  /** Message type (m.text, m.image, etc.) */
  msgType: string;
  /** Formatted body (HTML) */
  formattedBody?: string;
  /** Timestamp */
  timestamp: number;
  /** Thread root event ID */
  threadId?: string;
  /** Reply-to event ID */
  replyTo?: string;
  /** Whether this is an edit */
  isEdit: boolean;
  /** Original event ID if this is an edit */
  replacesEventId?: string;
}

/** Options for sending a message */
export interface MatrixMessageSendOptions {
  /** Room ID or alias to send to */
  roomId?: string;
  /** Event ID to reply to */
  replyTo?: string;
  /** Thread root event ID */
  threadId?: string;
  /** Format as HTML */
  formatted?: boolean;
  /** Media URL to attach */
  mediaUrl?: string;
}

/** Result from sending a message */
export interface MatrixSendResult {
  /** Whether the send succeeded */
  success: boolean;
  /** Event ID of the sent message */
  eventId?: string;
  /** Room ID */
  roomId?: string;
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// Service Interface
// ============================================================================

/** Interface for the Matrix service */
export interface IMatrixService extends Service {
  /** Check if the service is connected */
  isConnected(): boolean;

  /** Get the user ID */
  getUserId(): string;

  /** Get the homeserver URL */
  getHomeserver(): string;

  /** Get joined rooms */
  getJoinedRooms(): Promise<MatrixRoom[]>;

  /** Send a message */
  sendMessage(text: string, options?: MatrixMessageSendOptions): Promise<MatrixSendResult>;

  /** Send a reaction */
  sendReaction(roomId: string, eventId: string, emoji: string): Promise<MatrixSendResult>;

  /** Join a room */
  joinRoom(roomIdOrAlias: string): Promise<string>;

  /** Leave a room */
  leaveRoom(roomId: string): Promise<void>;

  /** Send typing indicator */
  sendTyping(roomId: string, typing: boolean, timeout?: number): Promise<void>;

  /** Send read receipt */
  sendReadReceipt(roomId: string, eventId: string): Promise<void>;
}

// ============================================================================
// Event Payloads
// ============================================================================

/** Payload for MESSAGE_RECEIVED event */
export interface MatrixMessageReceivedPayload {
  message: MatrixMessage;
  room: MatrixRoom;
  runtime: IAgentRuntime;
}

/** Payload for MESSAGE_SENT event */
export interface MatrixMessageSentPayload {
  roomId: string;
  eventId: string;
  content: string;
}

/** Payload for ROOM_JOINED event */
export interface MatrixRoomJoinedPayload {
  room: MatrixRoom;
}

/** Payload for INVITE_RECEIVED event */
export interface MatrixInviteReceivedPayload {
  roomId: string;
  inviter: string;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a string is a valid Matrix user ID.
 */
export function isValidMatrixUserId(userId: string): boolean {
  return /^@[^:]+:.+$/.test(userId);
}

/**
 * Check if a string is a valid Matrix room ID.
 */
export function isValidMatrixRoomId(roomId: string): boolean {
  return /^![^:]+:.+$/.test(roomId);
}

/**
 * Check if a string is a valid Matrix room alias.
 */
export function isValidMatrixRoomAlias(alias: string): boolean {
  return /^#[^:]+:.+$/.test(alias);
}

/**
 * Extract the localpart from a Matrix ID.
 */
export function getMatrixLocalpart(matrixId: string): string {
  const match = matrixId.match(/^[@#!]([^:]+):/);
  return match ? match[1] : matrixId;
}

/**
 * Extract the server part from a Matrix ID.
 */
export function getMatrixServerpart(matrixId: string): string {
  const match = matrixId.match(/:(.+)$/);
  return match ? match[1] : "";
}

/**
 * Get the best display name for a Matrix user.
 */
export function getMatrixUserDisplayName(user: MatrixUserInfo): string {
  return user.displayName || getMatrixLocalpart(user.userId);
}

/**
 * Convert a media URL to an HTTP URL via homeserver.
 */
export function matrixMxcToHttp(mxcUrl: string, homeserver: string): string | undefined {
  if (!mxcUrl.startsWith("mxc://")) {
    return undefined;
  }
  const [serverName, mediaId] = mxcUrl.slice(6).split("/");
  if (!serverName || !mediaId) {
    return undefined;
  }
  const base = homeserver.replace(/\/$/, "");
  return `${base}/_matrix/media/v3/download/${serverName}/${mediaId}`;
}

// ============================================================================
// Custom Errors
// ============================================================================

/** Base error class for Matrix plugin errors */
export class MatrixPluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatrixPluginError";
  }
}

/** Error when the Matrix service is not initialized */
export class MatrixServiceNotInitializedError extends MatrixPluginError {
  constructor(message: string = "Matrix service is not initialized") {
    super(message);
    this.name = "MatrixServiceNotInitializedError";
  }
}

/** Error when the Matrix client is not connected */
export class MatrixNotConnectedError extends MatrixPluginError {
  constructor(message: string = "Matrix client is not connected") {
    super(message);
    this.name = "MatrixNotConnectedError";
  }
}

/** Error when there is a configuration problem */
export class MatrixConfigurationError extends MatrixPluginError {
  settingName?: string;

  constructor(message: string, settingName?: string) {
    super(message);
    this.name = "MatrixConfigurationError";
    this.settingName = settingName;
  }
}

/** Error when an API call fails */
export class MatrixApiError extends MatrixPluginError {
  errcode?: string;

  constructor(message: string, errcode?: string) {
    super(message);
    this.name = "MatrixApiError";
    this.errcode = errcode;
  }
}
