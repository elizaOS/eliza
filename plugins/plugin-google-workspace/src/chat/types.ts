/**
 * Type definitions for the Google Chat plugin.
 */

import { type Service, toWellFormedUnicode } from "@elizaos/core";

/** Google Chat's maximum message size, measured as UTF-8 bytes. */
export const MAX_GOOGLE_CHAT_MESSAGE_BYTES = 32_000;

/** @deprecated Use {@link MAX_GOOGLE_CHAT_MESSAGE_BYTES}; this value is a byte budget. */
export const MAX_GOOGLE_CHAT_MESSAGE_LENGTH = MAX_GOOGLE_CHAT_MESSAGE_BYTES;

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
  /** Every provider message name accepted for a chunked logical message. */
  messageNames?: string[];
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
    return isValidGoogleChatSpaceName(trimmed) ? trimmed : null;
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
    return isValidGoogleChatUserName(trimmed) ? trimmed : null;
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

// The pinned runtimes provide Intl.Segmenter, while the declaration library
// does not expose its type.
const GraphemeSegmenter = (
  Intl as unknown as {
    Segmenter: new (
      locale: string,
      options: { granularity: "grapheme" }
    ) => { segment(text: string): Iterable<{ segment: string }> };
  }
).Segmenter;

const graphemeSegmenter = new GraphemeSegmenter("en", {
  granularity: "grapheme",
});

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    bytes +=
      codePoint === undefined
        ? 0
        : codePoint <= 0x7f
          ? 1
          : codePoint <= 0x7ff
            ? 2
            : codePoint <= 0xffff
              ? 3
              : 4;
  }
  return bytes;
}

/**
 * Returns lossless, provider-sized, well-formed Unicode chunks for Google Chat.
 * Google Chat measures the message boundary in UTF-8 bytes, not JavaScript
 * UTF-16 code units. A chunk never ends inside a grapheme cluster (a ZWJ emoji
 * sequence, a regional-indicator flag, a combining mark, or a skin-tone
 * modifier), so a cluster is never split across two messages.
 */
export function splitMessageForGoogleChat(
  text: string,
  maxBytes: number = MAX_GOOGLE_CHAT_MESSAGE_BYTES
): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) {
    throw new RangeError("Google Chat message maxBytes must be an integer of at least 4");
  }

  const wellFormedText = toWellFormedUnicode(text);
  if (wellFormedText.length === 0) {
    return [wellFormedText];
  }

  const chunks: string[] = [];
  let remaining = wellFormedText;

  while (remaining.length > 0) {
    // Build the longest prefix that fits the byte budget without ending
    // inside a grapheme cluster: whole segments are added one at a time.
    const segmentEnds: number[] = [];
    let prefixLength = 0;
    let prefixBytes = 0;
    for (const { segment } of graphemeSegmenter.segment(remaining)) {
      const segmentBytes = utf8ByteLength(segment);
      if (prefixBytes + segmentBytes > maxBytes) {
        break;
      }
      prefixBytes += segmentBytes;
      prefixLength += segment.length;
      segmentEnds.push(prefixLength);
    }
    if (prefixLength === 0) {
      // A single grapheme cluster alone exceeds the byte budget, so fall back
      // to the code-point prefix; it is the only case with no clean boundary.
      for (const character of remaining) {
        const characterBytes = utf8ByteLength(character);
        if (prefixBytes + characterBytes > maxBytes) {
          break;
        }
        prefixBytes += characterBytes;
        prefixLength += character.length;
      }
    }
    if (prefixLength === 0) {
      throw new RangeError("Google Chat message maxBytes cannot fit the next Unicode scalar");
    }
    if (prefixLength === remaining.length) {
      chunks.push(remaining);
      break;
    }

    // Prefer breaking right after the last newline in the second half of the
    // prefix, else right after the last space there. Only segment boundaries
    // are candidates, so the break can never land inside a cluster.
    let breakPoint = prefixLength;
    for (const marker of ["\n", " "]) {
      let candidate = 0;
      for (const end of segmentEnds) {
        if (end - 1 > prefixLength * 0.5 && remaining[end - 1] === marker) {
          candidate = end;
        }
      }
      if (candidate > 0) {
        breakPoint = candidate;
        break;
      }
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint);
  }

  return chunks;
}
