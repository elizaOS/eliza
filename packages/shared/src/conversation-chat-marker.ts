/** Validates the host-owned durable chat marker and its deterministic request identity.
 * A valid shape is not an authorization grant; readers must also check the stored
 * message's producer, agent, room and requester before using its outcomes. */
import { stringToUuid, type UUID } from "@elizaos/core";

export function normalizeChatIdempotencyKey(
  value: unknown,
  maxKeyLength = 128,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxKeyLength
    ? normalized
    : null;
}

export function conversationClientUserMemoryId(
  scope: string,
  clientMessageId: string,
): UUID {
  return stringToUuid(`conversation-user:${scope}:${clientMessageId}`) as UUID;
}

export interface DurableConversationChatMarker {
  version: 1;
  scope: string;
  clientMessageId: string;
  fingerprint: string;
  outcomeJson?: string;
  /** Private evidence owned by this exact user turn, never a public outcome. */
  replyRecoveryJson?: string;
}

export function readDurableConversationChatMarker(
  value: unknown,
): DurableConversationChatMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.scope !== "string" ||
    record.scope.length === 0 ||
    typeof record.clientMessageId !== "string" ||
    normalizeChatIdempotencyKey(record.clientMessageId) !==
      record.clientMessageId ||
    typeof record.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.fingerprint) ||
    (record.outcomeJson !== undefined &&
      typeof record.outcomeJson !== "string") ||
    (record.replyRecoveryJson !== undefined &&
      typeof record.replyRecoveryJson !== "string")
  ) {
    return null;
  }
  return {
    version: 1,
    scope: record.scope,
    clientMessageId: record.clientMessageId,
    fingerprint: record.fingerprint,
    ...(typeof record.outcomeJson === "string"
      ? { outcomeJson: record.outcomeJson }
      : {}),
    ...(typeof record.replyRecoveryJson === "string"
      ? { replyRecoveryJson: record.replyRecoveryJson }
      : {}),
  };
}
