/**
 * Type definitions for the iMessage plugin.
 */

import type { Service } from "@elizaos/core";

/** Maximum message length for iMessage */
export const MAX_IMESSAGE_MESSAGE_LENGTH = 4000;

/** Default poll interval in ms */
export const DEFAULT_POLL_INTERVAL_MS = 5000;

/** iMessage service name constant */
export const IMESSAGE_SERVICE_NAME = "imessage";

/**
 * Event types emitted by the iMessage plugin
 */
export const IMessageEventTypes = {
  MESSAGE_RECEIVED: "IMESSAGE_MESSAGE_RECEIVED",
  MESSAGE_SENT: "IMESSAGE_MESSAGE_SENT",
  REACTION_RECEIVED: "IMESSAGE_REACTION_RECEIVED",
  SYSTEM_EVENT: "IMESSAGE_SYSTEM_EVENT",
  CONNECTION_READY: "IMESSAGE_CONNECTION_READY",
  ERROR: "IMESSAGE_ERROR",
} as const;

export type IMessageEventType = (typeof IMessageEventTypes)[keyof typeof IMessageEventTypes];

/**
 * iMessage chat types
 */
export type IMessageChatType = "direct" | "group";

/**
 * Configuration settings for the iMessage plugin
 */
export interface IMessageSettings {
  /** Path to iMessage CLI tool */
  cliPath: string;
  /** Path to iMessage database */
  dbPath?: string;
  /** Polling interval in ms */
  pollIntervalMs: number;
  /** DM policy */
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  /** Group policy */
  groupPolicy: "open" | "allowlist" | "disabled";
  /** Handles/phone numbers for allowlist */
  allowFrom: string[];
  /** Enable/disable the plugin */
  enabled: boolean;
}

/**
 * iMessage contact
 */
export interface IMessageContact {
  /** Handle (phone number or email) */
  handle: string;
  /** Display name */
  displayName?: string;
  /** Is this a phone number? */
  isPhoneNumber: boolean;
}

/**
 * iMessage chat
 */
export interface IMessageChat {
  /** Chat ID */
  chatId: string;
  /** Chat type */
  chatType: IMessageChatType;
  /** Display name */
  displayName?: string;
  /** Participants */
  participants: IMessageContact[];
}

/**
 * iMessage message
 */
export interface IMessageMessage {
  /** Message ID (ROWID) */
  id: string;
  /** Message text */
  text: string;
  /** Sender handle */
  handle: string;
  /** Chat ID */
  chatId: string;
  /** Timestamp */
  timestamp: number;
  /** Is from me */
  isFromMe: boolean;
  /** Has attachments */
  hasAttachments: boolean;
  /** Attachment paths */
  attachmentPaths?: string[];
}

export interface IMessageListMessagesOptions {
  /** Return only messages from this chat identifier. */
  chatId?: string;
  /** Maximum number of rows to return. */
  limit?: number;
}

/**
 * Options for sending a message
 */
export interface IMessageSendOptions {
  /** Connector account ID. iMessage currently supports only the local default account. */
  accountId?: string;
  /** Media URL or path to attach */
  mediaUrl?: string;
  /** Max bytes for media */
  maxBytes?: number;
}

/**
 * Result from sending a message
 */
export interface IMessageSendResult {
  success: boolean;
  messageId?: string;
  chatId?: string;
  error?: string;
}

export interface IMessagePermissionAction {
  type: "full_disk_access";
  label: string;
  url: string;
  instructions: string[];
}

export interface IMessageServiceStatus {
  available: boolean;
  connected: boolean;
  chatDbAvailable: boolean;
  sendOnly: boolean;
  chatDbPath: string;
  reason: string | null;
  permissionAction: IMessagePermissionAction | null;
}

/**
 * Service interface for iMessage
 */
export interface IIMessageService extends Service {
  /** Check if the service is connected */
  isConnected(): boolean;

  /** Get structured readiness for UI/API callers */
  getStatus(): IMessageServiceStatus;

  /** Check if running on macOS */
  isMacOS(): boolean;

  /** Send a message */
  sendMessage(to: string, text: string, options?: IMessageSendOptions): Promise<IMessageSendResult>;

  /** Get recent messages */
  getRecentMessages(limit?: number): Promise<IMessageMessage[]>;

  /** List newest messages, optionally filtered to one chat. */
  getMessages(options?: IMessageListMessagesOptions): Promise<IMessageMessage[]>;

  /** Get chats */
  getChats(): Promise<IMessageChat[]>;
}

/**
 * iMessage plugin errors
 */
export class IMessagePluginError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "IMessagePluginError";
  }
}

export class IMessageConfigurationError extends IMessagePluginError {
  constructor(message: string, setting?: string) {
    super(message, "CONFIGURATION_ERROR", setting ? { setting } : undefined);
    this.name = "IMessageConfigurationError";
  }
}

export class IMessageNotSupportedError extends IMessagePluginError {
  constructor(message: string = "iMessage is only supported on macOS") {
    super(message, "NOT_SUPPORTED");
    this.name = "IMessageNotSupportedError";
  }
}

export class IMessageCliError extends IMessagePluginError {
  constructor(message: string, exitCode?: number) {
    super(message, "CLI_ERROR", exitCode !== undefined ? { exitCode } : undefined);
    this.name = "IMessageCliError";
  }
}

// Utility functions

/**
 * Check if a string looks like a phone number
 */
export function isPhoneNumber(input: string): boolean {
  // Remove common formatting
  const cleaned = input.replace(/[\s\-().]/g, "");
  // Check if it's a phone number pattern
  return /^\+?\d{10,15}$/.test(cleaned);
}

/**
 * Check if a string looks like an email
 */
export function isEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
}

/**
 * Check if a string is a valid iMessage target (phone or email)
 */
export function isValidIMessageTarget(target: string): boolean {
  const trimmed = target.trim();
  return isPhoneNumber(trimmed) || isEmail(trimmed) || trimmed.startsWith("chat_id:");
}

/**
 * Normalize an iMessage target
 */
export function normalizeIMessageTarget(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) {
    return null;
  }

  // Handle chat_id: prefix
  if (trimmed.startsWith("chat_id:")) {
    return trimmed;
  }

  // Handle imessage: prefix
  if (trimmed.toLowerCase().startsWith("imessage:")) {
    return trimmed.slice(9).trim();
  }

  // Return as-is for phone numbers and emails
  return trimmed;
}

/**
 * Format a phone number for iMessage
 */
export function formatPhoneNumber(phone: string): string {
  // Remove formatting
  let cleaned = phone.replace(/[\s\-().]/g, "");

  // Add + prefix if missing for international
  if (cleaned.length > 10 && !cleaned.startsWith("+")) {
    cleaned = `+${cleaned}`;
  }

  return cleaned;
}

/**
 * Split text for iMessage
 */
export function splitMessageForIMessage(
  text: string,
  maxLength: number = MAX_IMESSAGE_MESSAGE_LENGTH
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

    let breakPoint = maxLength;

    // Try newline first
    const newlineIdx = remaining.lastIndexOf("\n", maxLength);
    if (newlineIdx > maxLength / 2) {
      breakPoint = newlineIdx + 1;
    } else {
      // Try space
      const spaceIdx = remaining.lastIndexOf(" ", maxLength);
      if (spaceIdx > maxLength / 2) {
        breakPoint = spaceIdx + 1;
      }
    }

    chunks.push(remaining.slice(0, breakPoint).trimEnd());
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}
