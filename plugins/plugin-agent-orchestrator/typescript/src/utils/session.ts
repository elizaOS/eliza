import crypto from "node:crypto";
import type { UUID } from "@elizaos/core";
import type { DeliveryContext, ParsedSessionKey } from "../types/subagent.js";

// Re-export core session utilities for convenience
export {
  // Session key building/parsing
  buildAgentMainSessionKey,
  buildAgentSessionKey,
  buildAgentPeerSessionKey,
  buildAcpSessionKey,
  buildSubagentSessionKey,
  parseAgentSessionKey,
  isAcpSessionKey,
  isSubagentSessionKey as isCoreSubagentSessionKey,
  normalizeAgentId as normalizeCoreAgentId,
  normalizeMainKey,
  normalizeAccountId,
  toAgentRequestSessionKey,
  toAgentStoreSessionKey,
  resolveAgentIdFromSessionKey,
  resolveThreadParentSessionKey,
  resolveThreadSessionKeys,
  buildGroupHistoryKey,
  // Session types
  type SessionEntry,
  type SessionStore,
  type SessionDeliveryContext,
  type SessionResolution,
  // Session store operations
  loadSessionStore,
  saveSessionStore,
  updateSessionStore,
  updateSessionStoreEntry,
  getSessionEntry,
  upsertSessionEntry,
  deleteSessionEntry,
  listSessionKeys,
  // Session paths
  resolveStateDir,
  resolveAgentSessionsDir,
  resolveDefaultSessionStorePath,
  resolveSessionTranscriptPath,
  resolveStorePath,
  // Session providers
  createSessionProvider,
  createSessionSkillsProvider,
  createSendPolicyProvider,
  getSessionProviders,
  extractSessionContext,
  SessionStateManager,
  // Session entry utilities
  createSessionEntry,
  mergeSessionEntry,
  isValidSessionEntry,
} from "@elizaos/core";

/**
 * Converts a string to a deterministic UUID v5.
 * Uses SHA-256 to hash the input and formats it as a UUID.
 *
 * @param input - The string to convert
 * @returns A deterministic UUID
 */
export function hashToUUID(input: string): UUID {
  const hash = crypto.createHash("sha256").update(input).digest("hex");
  // Format as UUID v5-style (version 5, variant 1)
  const uuid = [
    hash.slice(0, 8),
    hash.slice(8, 12),
    // Version 5: first nibble is 5
    `5${hash.slice(13, 16)}`,
    // Variant 1: first nibble is 8, 9, a, or b
    `${(parseInt(hash.slice(16, 17), 16) & 0x3 | 0x8).toString(16)}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
  return uuid as UUID;
}

/**
 * Converts a session key to a deterministic Eliza room ID.
 *
 * @param sessionKey - The Otto-style session key
 * @param agentId - Optional agent ID to scope the room
 * @returns A deterministic UUID for the room
 */
export function sessionKeyToRoomId(sessionKey: string, agentId?: string): UUID {
  const normalized = normalizeSessionKey(sessionKey);
  const input = agentId ? `${agentId}:${normalized}` : normalized;
  return hashToUUID(input);
}

/**
 * Normalizes a session key to a canonical format.
 *
 * @param sessionKey - The session key to normalize
 * @returns Normalized session key
 */
export function normalizeSessionKey(sessionKey: string): string {
  const trimmed = sessionKey.trim();
  if (!trimmed) {
    return "";
  }
  // If it already starts with "agent:", return as-is
  if (trimmed.startsWith("agent:")) {
    return trimmed;
  }
  // Legacy keys like "main" or "dm:user123" need to be prefixed
  // But we can't know the agent ID here, so return as-is
  return trimmed;
}

/**
 * Parses a session key into its component parts.
 *
 * Supported formats:
 * - "agent:botname:dm:user123" -> { agentId: "botname", keyType: "dm", identifier: "user123" }
 * - "agent:botname:subagent:uuid" -> { agentId: "botname", keyType: "subagent", identifier: "uuid" }
 * - "agent:botname:group:channelId" -> { agentId: "botname", keyType: "group", identifier: "channelId" }
 * - "dm:user123" -> { agentId: "unknown", keyType: "dm", identifier: "user123" }
 *
 * @param sessionKey - The session key to parse
 * @returns Parsed components
 */
export function parseSessionKey(sessionKey: string): ParsedSessionKey {
  const trimmed = sessionKey.trim();

  if (!trimmed) {
    return {
      agentId: "unknown",
      keyType: "unknown",
      identifier: "",
    };
  }

  // Handle "agent:NAME:TYPE:IDENTIFIER" format
  if (trimmed.startsWith("agent:")) {
    const parts = trimmed.split(":");
    if (parts.length >= 4) {
      const agentId = parts[1]!;
      const keyTypeRaw = parts[2]!;
      const identifier = parts.slice(3).join(":");
      const keyType = normalizeKeyType(keyTypeRaw);

      return {
        agentId,
        keyType,
        identifier,
      };
    }
    // Malformed agent: key
    if (parts.length >= 2) {
      return {
        agentId: parts[1]!,
        keyType: "unknown",
        identifier: parts.slice(2).join(":") ?? "",
      };
    }
  }

  // Handle legacy "TYPE:IDENTIFIER" format
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex > 0) {
    const keyTypeRaw = trimmed.slice(0, colonIndex);
    const identifier = trimmed.slice(colonIndex + 1);
    const keyType = normalizeKeyType(keyTypeRaw);

    return {
      agentId: "unknown",
      keyType,
      identifier,
    };
  }

  // Single identifier (e.g., "main", "global")
  return {
    agentId: "unknown",
    keyType: "unknown",
    identifier: trimmed,
  };
}

/**
 * Normalizes a key type string to a known type.
 */
function normalizeKeyType(
  raw: string,
): "dm" | "subagent" | "group" | "channel" | "unknown" {
  const lower = raw.toLowerCase();
  switch (lower) {
    case "dm":
    case "direct":
      return "dm";
    case "subagent":
    case "sub":
      return "subagent";
    case "group":
    case "server":
      return "group";
    case "channel":
      return "channel";
    default:
      return "unknown";
  }
}

/**
 * Builds a session key from its component parts.
 *
 * @param agentId - The agent ID
 * @param keyType - The key type (dm, subagent, group, etc.)
 * @param identifier - The unique identifier
 * @returns Constructed session key
 */
export function buildSessionKey(
  agentId: string,
  keyType: string,
  identifier: string,
): string {
  const normalizedAgentId = normalizeAgentId(agentId);
  return `agent:${normalizedAgentId}:${keyType}:${identifier}`;
}

/**
 * Normalizes an agent ID to lowercase.
 *
 * @param agentId - The agent ID to normalize
 * @returns Normalized agent ID
 */
export function normalizeAgentId(agentId: string): string {
  return agentId.trim().toLowerCase();
}

/**
 * Checks if a session key represents a subagent.
 *
 * @param sessionKey - The session key to check
 * @returns True if this is a subagent session
 */
export function isSubagentSessionKey(sessionKey: string): boolean {
  const parsed = parseSessionKey(sessionKey);
  return parsed.keyType === "subagent";
}

/**
 * Extracts the agent ID from a session key.
 *
 * @param sessionKey - The session key
 * @returns The agent ID or "unknown"
 */
export function extractAgentIdFromSessionKey(sessionKey: string): string {
  const parsed = parseSessionKey(sessionKey);
  return parsed.agentId;
}

/**
 * Creates a subagent session key with a unique identifier.
 *
 * @param agentId - The agent ID
 * @returns A new subagent session key
 */
export function createSubagentSessionKey(agentId: string): string {
  const uuid = crypto.randomUUID();
  return buildSessionKey(agentId, "subagent", uuid);
}

/**
 * Normalizes a delivery context by removing undefined values.
 *
 * @param context - The context to normalize
 * @returns Normalized delivery context or undefined
 */
export function normalizeDeliveryContext(
  context?: DeliveryContext | null,
): DeliveryContext | undefined {
  if (!context) {
    return undefined;
  }

  const result: DeliveryContext = {};

  if (context.channel && typeof context.channel === "string") {
    const trimmed = context.channel.trim();
    if (trimmed) result.channel = trimmed;
  }
  if (context.accountId && typeof context.accountId === "string") {
    const trimmed = context.accountId.trim();
    if (trimmed) result.accountId = trimmed;
  }
  if (context.to && typeof context.to === "string") {
    const trimmed = context.to.trim();
    if (trimmed) result.to = trimmed;
  }
  if (context.threadId !== undefined && context.threadId !== null) {
    result.threadId = context.threadId;
  }
  if (context.groupId && typeof context.groupId === "string") {
    const trimmed = context.groupId.trim();
    if (trimmed) result.groupId = trimmed;
  }
  if (context.groupChannel && typeof context.groupChannel === "string") {
    const trimmed = context.groupChannel.trim();
    if (trimmed) result.groupChannel = trimmed;
  }
  if (context.groupSpace && typeof context.groupSpace === "string") {
    const trimmed = context.groupSpace.trim();
    if (trimmed) result.groupSpace = trimmed;
  }

  // Return undefined if all fields are empty
  const hasValues = Object.values(result).some(
    (v) => v !== undefined && v !== null,
  );
  return hasValues ? result : undefined;
}

/**
 * Merges two delivery contexts, with the first taking priority.
 *
 * @param primary - Primary context (takes priority)
 * @param secondary - Secondary context (fallback values)
 * @returns Merged context
 */
export function mergeDeliveryContext(
  primary?: DeliveryContext,
  secondary?: DeliveryContext,
): DeliveryContext | undefined {
  if (!primary && !secondary) {
    return undefined;
  }
  if (!primary) {
    return normalizeDeliveryContext(secondary);
  }
  if (!secondary) {
    return normalizeDeliveryContext(primary);
  }

  return normalizeDeliveryContext({
    channel: primary.channel || secondary.channel,
    accountId: primary.accountId || secondary.accountId,
    to: primary.to || secondary.to,
    threadId: primary.threadId ?? secondary.threadId,
    groupId: primary.groupId || secondary.groupId,
    groupChannel: primary.groupChannel || secondary.groupChannel,
    groupSpace: primary.groupSpace || secondary.groupSpace,
  } as import("../types/subagent.js").DeliveryContext);
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration (e.g., "1h2m", "45s")
 */
export function formatDurationShort(ms?: number): string | undefined {
  if (!ms || !Number.isFinite(ms) || ms <= 0) {
    return undefined;
  }

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Formats a token count to a human-readable string.
 *
 * @param count - Token count
 * @returns Formatted count (e.g., "1.5k", "2.3m")
 */
export function formatTokenCount(count?: number): string {
  if (!count || !Number.isFinite(count)) {
    return "0";
  }
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}m`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return String(Math.round(count));
}
