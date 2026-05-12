/**
 * Type definitions for the Google Chat plugin.
 */

import type { Service } from "@elizaos/core";

/** Maximum message length for Google Chat */
export const MAX_GOOGLE_CHAT_MESSAGE_LENGTH = 4000;

/** Google Chat service name */
export const GOOGLE_CHAT_SERVICE_NAME = "google-chat";

/** Event types emitted by the Google Chat plugin */
export enum GoogleChatEventTypes {
  MESSAGE_RECEIVED = "GOOGLE_CHAT_MESSAGE_RECEIVED",
  MESSAGE_SENT = "GOOGLE_CHAT_MESSAGE_SENT",
  SPACE_JOINED = "GOOGLE_CHAT_SPACE_JOINED",
  SPACE_LEFT = "GOOGLE_CHAT_SPACE_LEFT",
  REACTION_RECEIVED = "GOOGLE_CHAT_REACTION_RECEIVED",
  REACTION_SENT = "GOOGLE_CHAT_REACTION_SENT",
  WEBHOOK_READY = "GOOGLE_CHAT_WEBHOOK_READY",
  CONNECTION_READY = "GOOGLE_CHAT_CONNECTION_READY",
}

/** Audience type for token verification */
export type GoogleChatAudienceType = "app-url" | "project-number";

/** Configuration settings for the Google Chat plugin */
export interface GoogleChatSettings {
  /** Connector account identifier for this Google Chat bot instance */
  accountId?: string;
  /** Service account JSON credentials */
  serviceAccount?: string;
  /** Path to service account JSON file */
  serviceAccountFile?: string;
  /** Audience type for verification */
  audienceType: GoogleChatAudienceType;
  /** Audience value for verification */
  audience: string;
  /** Webhook path for receiving messages */
  webhookPath: string;
  /** List of spaces to interact with */
  spaces: string[];
  /** Whether to require @mention in spaces */
  requireMention: boolean;
  /** Whether the plugin is enabled */
  enabled: boolean;
  /** Bot user identifier */
  botUser?: string;
}

/** Google Chat space information */
export interface GoogleChatSpace {
  name: string;
  displayName?: string;
  type: "DM" | "ROOM" | "SPACE";
  singleUserBotDm?: boolean;
  threaded?: boolean;
  spaceType?: string;
}

/** Google Chat user information */
export interface GoogleChatUser {
  name: string;
  displayName?: string;
  email?: string;
  type?: string;
  domainId?: string;
  isAnonymous?: boolean;
}

/** Google Chat thread information */
export interface GoogleChatThread {
  name: string;
  threadKey?: string;
}

/** Google Chat attachment data reference */
export interface GoogleChatAttachmentDataRef {
  resourceName?: string;
  attachmentUploadToken?: string;
}

/** Google Chat attachment */
export interface GoogleChatAttachment {
  name?: string;
  contentName?: string;
  contentType?: string;
  thumbnailUri?: string;
  downloadUri?: string;
  source?: string;
  attachmentDataRef?: GoogleChatAttachmentDataRef;
  driveDataRef?: Record<string, unknown>;
}

/** Google Chat message */
export interface GoogleChatMessage {
  name: string;
  text?: string;
  argumentText?: string;
  sender: GoogleChatUser;
  createTime: string;
  thread?: GoogleChatThread;
  space: GoogleChatSpace;
  attachment?: GoogleChatAttachment[];
  annotations?: GoogleChatAnnotation[];
}

/** Google Chat annotation (mention, etc.) */
export interface GoogleChatAnnotation {
  type?: string;
  startIndex?: number;
  length?: number;
  userMention?: {
    user?: GoogleChatUser;
    type?: string;
  };
  slashCommand?: Record<string, unknown>;
}

/** Google Chat webhook event */
export interface GoogleChatEvent {
  type: string;
  eventTime?: string;
  space?: GoogleChatSpace;
  user?: GoogleChatUser;
  message?: GoogleChatMessage;
}

/** Google Chat reaction */
export interface GoogleChatReaction {
  name?: string;
  user?: GoogleChatUser;
  emoji?: {
    unicode?: string;
  };
}

/** Options for sending a message */
export interface GoogleChatMessageSendOptions {
  /** Connector account identifier */
  accountId?: string;
  /** Target space name */
  space?: string;
  /** Thread name for replying in thread */
  thread?: string;
  /** Text message content */
  text?: string;
  /** Attachment upload tokens */
  attachments?: Array<{
    attachmentUploadToken: string;
    contentName?: string;
  }>;
}

/** Result from sending a message */
export interface GoogleChatSendResult {
  success: boolean;
  messageName?: string;
  space?: string;
  error?: string;
}

/** Google Chat service interface */
export interface IGoogleChatService extends Service {
  /** Check if the service is connected */
  isConnected(): boolean;

  /** Get the bot user name */
  getBotUser(): string | undefined;

  /** Get spaces the bot is in */
  getSpaces(): Promise<GoogleChatSpace[]>;

  /** Send a message */
  sendMessage(options: GoogleChatMessageSendOptions): Promise<GoogleChatSendResult>;

  /** Send a reaction */
  sendReaction(
    messageName: string,
    emoji: string
  ): Promise<{ success: boolean; name?: string; error?: string }>;

  /** Delete a message */
  deleteMessage(messageName: string): Promise<{ success: boolean; error?: string }>;

  /** Update a message */
  updateMessage(
    messageName: string,
    text: string
  ): Promise<{ success: boolean; messageName?: string; error?: string }>;

  /** Find or create a DM space with a user */
  findDirectMessage(userName: string): Promise<GoogleChatSpace | null>;

  /** Get an access token for API calls */
  getAccessToken(): Promise<string>;
}

// Custom error classes

/** Base error class for Google Chat plugin errors */
export class GoogleChatPluginError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "GoogleChatPluginError";
  }
}

/** Configuration error */
export class GoogleChatConfigurationError extends GoogleChatPluginError {
  public readonly setting?: string;

  constructor(message: string, setting?: string, cause?: Error) {
    super(message, "CONFIGURATION_ERROR", cause);
    this.name = "GoogleChatConfigurationError";
    this.setting = setting;
  }
}

/** API error */
export class GoogleChatApiError extends GoogleChatPluginError {
  public readonly statusCode?: number;

  constructor(message: string, statusCode?: number, cause?: Error) {
    super(message, "API_ERROR", cause);
    this.name = "GoogleChatApiError";
    this.statusCode = statusCode;
  }
}

/** Authentication error */
export class GoogleChatAuthenticationError extends GoogleChatPluginError {
  constructor(message: string, cause?: Error) {
    super(message, "AUTHENTICATION_ERROR", cause);
    this.name = "GoogleChatAuthenticationError";
  }
}

// Utility functions

/** Regex for validating Google Chat space names */
const SPACE_NAME_REGEX = /^spaces\/[A-Za-z0-9_-]+$/;

/** Regex for validating Google Chat user names */
const USER_NAME_REGEX = /^users\/[A-Za-z0-9_-]+$/;

/** Check if a string is a valid Google Chat space name */
export function isValidGoogleChatSpaceName(name: string): boolean {
  return SPACE_NAME_REGEX.test(name);
}

/** Check if a string is a valid Google Chat user name */
export function isValidGoogleChatUserName(name: string): boolean {
  return USER_NAME_REGEX.test(name);
}

/** Normalize a Google Chat space target */
export function normalizeSpaceTarget(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("spaces/")) {
    return trimmed;
  }
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return `spaces/${trimmed}`;
  }
  return null;
}

/** Normalize a Google Chat user target */
export function normalizeUserTarget(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("users/")) {
    return trimmed;
  }
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return `users/${trimmed}`;
  }
  return null;
}

/** Extract the ID from a Google Chat resource name */
export function extractResourceId(resourceName: string): string {
  const parts = resourceName.split("/");
  return parts[parts.length - 1];
}

/** Get display name for a user */
export function getUserDisplayName(user: GoogleChatUser): string {
  return user.displayName || extractResourceId(user.name);
}

/** Get display name for a space */
export function getSpaceDisplayName(space: GoogleChatSpace): string {
  return space.displayName || extractResourceId(space.name);
}

/** Check if a space is a DM */
export function isDirectMessage(space: GoogleChatSpace): boolean {
  return space.type === "DM" || space.singleUserBotDm === true;
}

/** Split long text into chunks for Google Chat */
export function splitMessageForGoogleChat(
  text: string,
  maxLength: number = MAX_GOOGLE_CHAT_MESSAGE_LENGTH
): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find a good break point
    let breakPoint = maxLength;
    const newlineIndex = remaining.lastIndexOf("\n", maxLength);
    if (newlineIndex > maxLength * 0.5) {
      breakPoint = newlineIndex + 1;
    } else {
      const spaceIndex = remaining.lastIndexOf(" ", maxLength);
      if (spaceIndex > maxLength * 0.5) {
        breakPoint = spaceIndex + 1;
      }
    }

    chunks.push(remaining.slice(0, breakPoint).trimEnd());
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}
