import type { Character, EventPayload, MessagePayload, WorldPayload } from "@elizaos/core";

/**
 * Signal-specific event types
 */
export enum SignalEventTypes {
  MESSAGE_RECEIVED = "SIGNAL_MESSAGE_RECEIVED",
  MESSAGE_SENT = "SIGNAL_MESSAGE_SENT",
  REACTION_RECEIVED = "SIGNAL_REACTION_RECEIVED",
  GROUP_JOINED = "SIGNAL_GROUP_JOINED",
  GROUP_LEFT = "SIGNAL_GROUP_LEFT",
  TYPING_STARTED = "SIGNAL_TYPING_STARTED",
  TYPING_STOPPED = "SIGNAL_TYPING_STOPPED",
  READ_RECEIPT = "SIGNAL_READ_RECEIPT",
}

export interface SignalMessageReceivedPayload extends MessagePayload {
  sender: string;
  groupId: string | undefined;
  timestamp: number;
  attachments: SignalAttachment[];
  isGroupMessage: boolean;
}

export interface SignalMessageSentPayload extends MessagePayload {
  recipient: string;
  groupId: string | undefined;
  timestamp: number;
}

export interface SignalReactionPayload extends EventPayload {
  emoji: string;
  sender: string;
  targetTimestamp: number;
  targetAuthor: string;
  isRemove: boolean;
}

export interface SignalGroupPayload extends WorldPayload {
  groupId: string;
  groupName: string;
  members: string[];
}

export interface SignalAttachment {
  contentType: string;
  filename: string | undefined;
  id: string;
  size: number;
  width: number | undefined;
  height: number | undefined;
  caption: string | undefined;
  blurhash: string | undefined;
}

export interface SignalEventPayloadMap {
  [SignalEventTypes.MESSAGE_RECEIVED]: SignalMessageReceivedPayload;
  [SignalEventTypes.MESSAGE_SENT]: SignalMessageSentPayload;
  [SignalEventTypes.REACTION_RECEIVED]: SignalReactionPayload;
  [SignalEventTypes.GROUP_JOINED]: SignalGroupPayload;
  [SignalEventTypes.GROUP_LEFT]: SignalGroupPayload;
}

export interface SignalContact {
  number: string;
  uuid: string | undefined;
  name: string | undefined;
  profileName: string | undefined;
  color: string | undefined;
  blocked: boolean;
}

export interface SignalGroup {
  id: string;
  name: string;
  description: string | undefined;
  isMember: boolean;
  isBlocked: boolean;
  members: SignalGroupMember[];
  admins: string[];
  inviteLink: string | undefined;
}

export interface SignalGroupMember {
  uuid: string;
  number: string | undefined;
  role: "ADMINISTRATOR" | "DEFAULT";
}

export interface SignalMessage {
  timestamp: number;
  sender: string;
  senderUuid: string | undefined;
  groupId: string | undefined;
  message: string | undefined;
  attachments: SignalAttachment[];
  quote: SignalQuote | undefined;
  reaction: SignalReactionInfo | undefined;
  expiresInSeconds: number | undefined;
  viewOnce: boolean;
}

export interface SignalRecentMessage {
  id: string;
  roomId: string;
  channelId: string;
  roomName: string;
  speakerName: string;
  text: string;
  createdAt: number;
  isFromAgent: boolean;
  isGroup: boolean;
}

export interface SignalQuote {
  id: number;
  author: string;
  authorUuid: string | undefined;
  text: string;
  attachments: SignalAttachment[];
}

export interface SignalReactionInfo {
  emoji: string;
  targetAuthor: string;
  targetAuthorUuid: string | undefined;
  targetSentTimestamp: number;
  isRemove: boolean;
}

export interface ISignalService {
  accountNumber: string | null;
  character: Character;
  isConnected: boolean;
  getRecentMessages(limit?: number): Promise<SignalRecentMessage[]>;
}

export const SIGNAL_SERVICE_NAME = "signal";

export const ServiceType = {
  SIGNAL: "signal",
} as const;

export interface SignalSettings {
  shouldIgnoreGroupMessages: boolean;
  allowedGroups: string[] | undefined;
  blockedNumbers: string[] | undefined;
  /**
   * When false (default), inbound messages are persisted as memories and a
   * MESSAGE_RECEIVED event is emitted, but the agent does NOT auto-generate
   * a reply. Sends only happen via explicit caller action (LifeOps send
   * route, user-issued chat command). Set SIGNAL_AUTO_REPLY=true to opt in.
   */
  autoReply: boolean;
  receiveMode: "on-start" | "manual";
}

export interface SignalMessageSendOptions {
  /** Connector account ID to send from. Defaults to the configured default account. */
  accountId?: string;
  attachments?: string[];
  quote?: { timestamp: number; author: string };
  expiresInSeconds?: number;
  record?: boolean;
}

export class SignalPluginError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "SignalPluginError";
  }
}

export class SignalServiceNotInitializedError extends SignalPluginError {
  constructor() {
    super("Signal service is not initialized", "SERVICE_NOT_INITIALIZED");
    this.name = "SignalServiceNotInitializedError";
  }
}

export class SignalClientNotAvailableError extends SignalPluginError {
  constructor() {
    super("Signal client is not available", "CLIENT_NOT_AVAILABLE");
    this.name = "SignalClientNotAvailableError";
  }
}

export class SignalConfigurationError extends SignalPluginError {
  constructor(missingConfig: string) {
    super(`Missing required configuration: ${missingConfig}`, "MISSING_CONFIG");
    this.name = "SignalConfigurationError";
  }
}

export class SignalApiError extends SignalPluginError {
  constructor(
    message: string,
    public readonly apiErrorCode: string | undefined
  ) {
    super(message, "API_ERROR");
    this.name = "SignalApiError";
  }
}

/**
 * Normalize a phone number to E.164 format
 */
export function normalizeE164(number: string): string | null {
  // Remove all non-digit characters except leading +
  let cleaned = number.replace(/[^\d+]/g, "");

  // Ensure it starts with +
  if (!cleaned.startsWith("+")) {
    // Assume US number if no country code
    if (cleaned.length === 10) {
      cleaned = `+1${cleaned}`;
    } else if (cleaned.length === 11 && cleaned.startsWith("1")) {
      cleaned = `+${cleaned}`;
    } else {
      cleaned = `+${cleaned}`;
    }
  }

  // Validate E.164 format: + followed by 7-15 digits
  if (!/^\+\d{7,15}$/.test(cleaned)) {
    return null;
  }

  return cleaned;
}

/**
 * Validates an E.164 phone number format
 */
export function isValidE164(number: string): boolean {
  return /^\+\d{7,15}$/.test(number);
}

/**
 * Validates a Signal group ID format (base64-encoded)
 */
export function isValidGroupId(id: string): boolean {
  // Signal group IDs are base64-encoded
  return /^[A-Za-z0-9+/]+=*$/.test(id) && id.length >= 32;
}

/**
 * Validates a Signal UUID format
 */
export function isValidUuid(uuid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
}

/**
 * Gets the display name for a Signal contact
 */
export function getSignalContactDisplayName(contact: SignalContact): string {
  return contact.profileName || contact.name || contact.number;
}

/**
 * Maximum message length for Signal messages
 */
export const MAX_SIGNAL_MESSAGE_LENGTH = 4000;

/**
 * Maximum attachment size (100MB)
 */
export const MAX_SIGNAL_ATTACHMENT_SIZE = 100 * 1024 * 1024;
