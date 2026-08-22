/**
 * A follow-up delivered into a LIVE session re-keys that session's voice.
 *
 * The router's request-voice ledger keys every relay on the session's origin
 * message (spawnRootMessageId). A follow-up ("also give it a dark mode
 * toggle") delivered to the same session produces a second task_complete
 * under the SAME key, which the ledger denies as a duplicate terminal — the
 * user heard "queued" and never heard "done" (live 2026-08-22, countdown
 * timer's dark-mode toggle).
 *
 * The follow-up's own message id is noted on the session when it is queued
 * and activated when it is actually delivered (direct send, idle flush, or
 * room forward), so the completion that answers it claims the follow-up's
 * slot. Stamping is best-effort metadata: a failure never blocks delivery.
 */
import type { Memory } from "@elizaos/core";

export const FOLLOW_UP_ORIGIN_KEY = "followUpOriginMessageId";
export const PENDING_FOLLOW_UP_ORIGIN_KEY = "pendingFollowUpOriginMessageId";

type SessionLike = { metadata?: Record<string, unknown> | null } | null;

export interface FollowUpOriginService {
  getSession(
    sessionId: string,
  ): Promise<SessionLike | undefined> | SessionLike | undefined;
  updateSessionMetadata?(
    sessionId: string,
    patch: Record<string, unknown>,
  ): Promise<void>;
}

function plain(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The connector message id of a room message (the same ladder the TASKS
 *  spawn paths use for the origin key), falling back to the memory id. */
export function originMessageIdFor(message: Memory): string | undefined {
  const content = record(message.content) ?? {};
  const contentMetadata = record(content.metadata);
  const messageMetadata = record(message.metadata);
  const discordMetadata = record(messageMetadata?.discord);
  return (
    plain(contentMetadata?.originConnectorMessageId) ??
    plain(contentMetadata?.replyToExternalMessageId) ??
    plain(messageMetadata?.messageIdFull) ??
    plain(messageMetadata?.discordMessageId) ??
    plain(discordMetadata?.messageId) ??
    plain(message.id)
  );
}

async function metadataOf(
  service: FollowUpOriginService,
  sessionId: string,
): Promise<Record<string, unknown>> {
  try {
    const session = await Promise.resolve(service.getSession(sessionId));
    return record(session?.metadata) ?? {};
  } catch {
    // error-policy:J4 best-effort read; an unreadable session stamps nothing
    return {};
  }
}

async function patch(
  service: FollowUpOriginService,
  sessionId: string,
  values: Record<string, unknown>,
): Promise<void> {
  if (typeof service.updateSessionMetadata !== "function") return;
  try {
    await service.updateSessionMetadata(sessionId, values);
  } catch {
    // error-policy:J4 voice re-keying is metadata; delivery proceeds without it
  }
}

export async function readFollowUpOrigin(
  service: FollowUpOriginService,
  sessionId: string,
): Promise<string | undefined> {
  return plain((await metadataOf(service, sessionId))[FOLLOW_UP_ORIGIN_KEY]);
}

/** The follow-up is QUEUED (session busy): remember its origin for the
 *  flush that delivers it. The in-flight turn keeps the current key. */
export async function notePendingFollowUpOrigin(
  service: FollowUpOriginService,
  sessionId: string,
  originMessageId: string | undefined,
): Promise<void> {
  if (!originMessageId) return;
  await patch(service, sessionId, {
    [PENDING_FOLLOW_UP_ORIGIN_KEY]: originMessageId,
  });
}

/** The follow-up is being DELIVERED: its origin becomes the session's voice
 *  key. With no explicit id, the pending (queued) origin is promoted. */
export async function activateFollowUpOrigin(
  service: FollowUpOriginService,
  sessionId: string,
  originMessageId?: string,
): Promise<void> {
  const id =
    originMessageId ??
    plain((await metadataOf(service, sessionId))[PENDING_FOLLOW_UP_ORIGIN_KEY]);
  if (!id) return;
  await patch(service, sessionId, {
    [FOLLOW_UP_ORIGIN_KEY]: id,
    [PENDING_FOLLOW_UP_ORIGIN_KEY]: "",
  });
}

/** A direct send lost the race to a busy session and was queued instead:
 *  hand the voice back to the in-flight turn and park the origin as pending. */
export async function restoreFollowUpOrigin(
  service: FollowUpOriginService,
  sessionId: string,
  previousActive: string | undefined,
  pendingId: string | undefined,
): Promise<void> {
  await patch(service, sessionId, {
    [FOLLOW_UP_ORIGIN_KEY]: previousActive ?? "",
    [PENDING_FOLLOW_UP_ORIGIN_KEY]: pendingId ?? "",
  });
}
