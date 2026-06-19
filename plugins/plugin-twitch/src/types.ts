/**
 * Type definitions for the Twitch plugin.
 */

import type { IAgentRuntime, Service } from "@elizaos/core";

// ============================================================================
// Constants
// ============================================================================

/** Maximum message length for Twitch chat */
export const MAX_TWITCH_MESSAGE_LENGTH = 500;

/** Service name constant */
export const TWITCH_SERVICE_NAME = "twitch";

// ============================================================================
// Event Types
// ============================================================================

/** Event types emitted by the Twitch plugin */
export enum TwitchEventTypes {
  MESSAGE_RECEIVED = "TWITCH_MESSAGE_RECEIVED",
  MESSAGE_SENT = "TWITCH_MESSAGE_SENT",
  JOIN_CHANNEL = "TWITCH_JOIN_CHANNEL",
  LEAVE_CHANNEL = "TWITCH_LEAVE_CHANNEL",
  CONNECTION_READY = "TWITCH_CONNECTION_READY",
  CONNECTION_LOST = "TWITCH_CONNECTION_LOST",
}

// ============================================================================
// Configuration Types
// ============================================================================

/** Twitch user roles for access control */
export type TwitchRole = "moderator" | "owner" | "vip" | "subscriber" | "all";

/** Configuration settings for the Twitch plugin */
export interface TwitchSettings {
  /** Connector account identifier for this Twitch bot instance */
  accountId?: string;
  /** Twitch username for the bot account */
  username: string;
  /** Twitch application client ID */
  clientId: string;
  /** OAuth access token */
  accessToken: string;
  /** Optional client secret for token refresh */
  clientSecret?: string;
  /** Optional refresh token for automatic token refresh */
  refreshToken?: string;
  /** Primary channel to join */
  channel: string;
  /** Additional channels to join */
  additionalChannels: string[];
  /** Whether to require @mention to respond */
  requireMention: boolean;
  /** Roles allowed to interact with the bot */
  allowedRoles: TwitchRole[];
  /** Optional allowlist of user IDs */
  allowedUserIds: string[];
  /** Whether this configuration is enabled */
  enabled: boolean;
}

// ============================================================================
// Message Types
// ============================================================================

/** Information about the message sender */
export interface TwitchUserInfo {
  /** Twitch user ID (numeric string) */
  userId: string;
  /** Twitch username (login name) */
  username: string;
  /** Display name (may include special characters) */
  displayName: string;
  /** Whether the user is a moderator */
  isModerator: boolean;
  /** Whether the user is the channel owner/broadcaster */
  isBroadcaster: boolean;
  /** Whether the user is a VIP */
  isVip: boolean;
  /** Whether the user is a subscriber */
  isSubscriber: boolean;
  /** User's chat color */
  color?: string;
  /** User's badges */
  badges: Map<string, string>;
}

/** Represents a Twitch chat message */
export interface TwitchMessage {
  /** Unique message ID */
  id: string;
  /** Channel name (without # prefix) */
  channel: string;
  /** Message text content */
  text: string;
  /** Sender information */
  user: TwitchUserInfo;
  /** Message timestamp */
  timestamp: Date;
  /** Whether this is an action message (/me) */
  isAction: boolean;
  /** Whether this is a highlighted message */
  isHighlighted: boolean;
  /** Reply thread info if this is a reply */
  replyTo?: {
    messageId: string;
    userId: string;
    username: string;
    text: string;
  };
}

/** Options for sending a message */
export interface TwitchMessageSendOptions {
  /** Channel to send to (defaults to primary channel) */
  channel?: string;
  /** Message ID to reply to */
  replyTo?: string;
}

/** Result from sending a message */
export interface TwitchSendResult {
  /** Whether the send succeeded */
  success: boolean;
  /** Generated message ID (if available) */
  messageId?: string;
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// Service Interface
// ============================================================================

/** Interface for the Twitch service */
export interface ITwitchService extends Service {
  /** Check if the service is connected */
  isConnected(): boolean;

  /** Get the bot username */
  getBotUsername(): string;

  /** Get the primary channel */
  getPrimaryChannel(): string;

  /** Get all joined channels */
  getJoinedChannels(): string[];

  /** Send a message to a channel */
  sendMessage(
    text: string,
    options?: TwitchMessageSendOptions,
  ): Promise<TwitchSendResult>;

  /** Join a channel */
  joinChannel(channel: string): Promise<void>;

  /** Leave a channel */
  leaveChannel(channel: string): Promise<void>;

  /** Check if a user is allowed to interact based on settings */
  isUserAllowed(user: TwitchUserInfo): boolean;
}

// ============================================================================
// Event Payloads
// ============================================================================

/** Payload for MESSAGE_RECEIVED event */
export interface TwitchMessageReceivedPayload {
  message: TwitchMessage;
  runtime: IAgentRuntime;
}

/** Payload for MESSAGE_SENT event */
export interface TwitchMessageSentPayload {
  channel: string;
  text: string;
  messageId?: string;
}

/** Payload for JOIN_CHANNEL event */
export interface TwitchJoinChannelPayload {
  channel: string;
}

/** Payload for LEAVE_CHANNEL event */
export interface TwitchLeaveChannelPayload {
  channel: string;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Normalize a Twitch channel name (ensure no # prefix).
 */
export function normalizeChannel(channel: string): string {
  return channel.startsWith("#") ? channel.slice(1) : channel;
}

/**
 * Format a channel name for display (with # prefix).
 */
export function formatChannelForDisplay(channel: string): string {
  const normalized = normalizeChannel(channel);
  return `#${normalized}`;
}

/**
 * Get the best display name for a Twitch user.
 */
export function getTwitchUserDisplayName(user: TwitchUserInfo): string {
  return user.displayName || user.username;
}

/**
 * Strip markdown formatting for Twitch chat display.
 * Twitch doesn't render markdown, so we convert it to plain text.
 */
export function stripMarkdownForTwitch(text: string): string {
  return (
    text
      // Remove bold
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      // Remove italic
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      // Remove strikethrough
      .replace(/~~([^~]+)~~/g, "$1")
      // Remove inline code
      .replace(/`([^`]+)`/g, "$1")
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, "[code block]")
      // Remove links, keep text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Remove headers
      .replace(/^#{1,6}\s+/gm, "")
      // Remove blockquotes
      .replace(/^>\s+/gm, "")
      // Remove list markers
      .replace(/^[-*+]\s+/gm, "• ")
      .replace(/^\d+\.\s+/gm, "• ")
      // Collapse multiple newlines
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Split a message into chunks that fit Twitch's message limit.
 */
export function splitMessageForTwitch(
  text: string,
  maxLength: number = MAX_TWITCH_MESSAGE_LENGTH,
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

    // Try to split at a sentence boundary
    let splitIndex = remaining.lastIndexOf(". ", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // Try to split at a word boundary
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // Force split at max length
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  return chunks;
}

// ============================================================================
// Custom Errors
// ============================================================================

/** Base error class for Twitch plugin errors */
export class TwitchPluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwitchPluginError";
  }
}

/** Error when the Twitch service is not initialized */
export class TwitchServiceNotInitializedError extends TwitchPluginError {
  constructor(message: string = "Twitch service is not initialized") {
    super(message);
    this.name = "TwitchServiceNotInitializedError";
  }
}

/** Error when the Twitch client is not connected */
export class TwitchNotConnectedError extends TwitchPluginError {
  constructor(message: string = "Twitch client is not connected") {
    super(message);
    this.name = "TwitchNotConnectedError";
  }
}

/** Error when there is a configuration problem */
export class TwitchConfigurationError extends TwitchPluginError {
  settingName?: string;

  constructor(message: string, settingName?: string) {
    super(message);
    this.name = "TwitchConfigurationError";
    this.settingName = settingName;
  }
}

/** Error when an API call fails */
export class TwitchApiError extends TwitchPluginError {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "TwitchApiError";
    this.statusCode = statusCode;
  }
}
