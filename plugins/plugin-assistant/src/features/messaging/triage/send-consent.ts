/** Message consent is bound to one actor, room, preview and later user turn. */
import { createHash, randomUUID } from "node:crypto";
import {
  ElizaError,
  type IAgentRuntime,
  type Memory,
  stableStringify,
  unwrapUserMessageText,
} from "@elizaos/core";
import type { DraftRecord } from "./types.ts";

export function sendConsentDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function draftConsentDigest(draft: DraftRecord): string {
  return sendConsentDigest({
    draftId: draft.draftId,
    agentId: draft.agentId,
    source: draft.source,
    inReplyToId: draft.inReplyToId,
    threadId: draft.threadId,
    worldId: draft.worldId,
    channelId: draft.channelId,
    to: draft.to,
    subject: draft.subject,
    body: draft.body,
    metadata: draft.metadata,
  });
}

interface PendingSend {
  nonce: string;
  digest: string;
  messageId: string;
  messageTime: number;
  armedAt: number;
  consumedBy: string | null;
  draftId?: string;
}

// A qualified answer is not blanket permission. Only an entire affirmative
// answer consumes consent; questions, edits and refusals require another preview.
const affirmative =
  /^(?:yes|yes please|yeah|yep|ok|okay|sure|confirm|confirmed|send|send it|send the draft|go ahead|do it|proceed|approve|approved|sí|si|oui|ja|はい|确认|確認|확인)[.!。！\s]*$/iu;

function pendingSend(value: unknown): value is PendingSend {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PendingSend>;
  return (
    typeof record.nonce === "string" &&
    typeof record.digest === "string" &&
    typeof record.messageId === "string" &&
    typeof record.messageTime === "number" &&
    Number.isFinite(record.messageTime) &&
    typeof record.armedAt === "number" &&
    Number.isFinite(record.armedAt) &&
    (record.draftId === undefined ||
      (typeof record.draftId === "string" && record.draftId.length > 0)) &&
    (record.consumedBy === null || typeof record.consumedBy === "string")
  );
}

export interface SendConsentOptions {
  /** Host-owned draft reference for a later reply; never send authority. */
  readonly draftId?: string;
  /**
   * Exact whole-turn replies that also confirm this send, e.g. the value a
   * one-tap choice chip posts. Compared case-insensitively after trimming.
   */
  readonly affirmations?: readonly string[];
}

/** Retire an older preview in the durable consent record before showing a new one.
 * This also protects explicit stale draft IDs, process restarts and other workers.
 */
export async function noteDraftPreview(
  runtime: IAgentRuntime,
  requester: Pick<Memory, "entityId" | "roomId"> | undefined,
  draftId: string,
): Promise<void> {
  if (!requester?.entityId || !requester.roomId || !draftId) return;
  const key = `message-consent:${requester.entityId}:${requester.roomId}`;
  const existing = await runtime.getCache<unknown>(key);
  if (
    !pendingSend(existing) ||
    existing.consumedBy !== null ||
    existing.draftId === draftId
  )
    return;
  const retired = await runtime.compareAndSetCache(key, existing, {
    ...existing,
    consumedBy: `superseded:${randomUUID()}`,
  });
  if (!retired)
    throw new ElizaError(
      "Send review changed while preparing this draft. Review it again.",
      {
        code: "MESSAGE_CONFIRMATION_PREVIEW_CHANGED",
      },
    );
}

/** Recover the preview's reference for an affirmative later turn in the same actor/room.
 * The caller must still check the current draft digest and consume consent.
 */
export async function pendingSendDraft(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<string | null> {
  if (
    !message.id ||
    !message.entityId ||
    !message.roomId ||
    !isAffirmative(unwrapUserMessageText(message).trim(), {}) ||
    message.entityId === runtime.agentId ||
    typeof message.createdAt !== "number" ||
    !Number.isFinite(message.createdAt)
  )
    return null;
  const existing = await runtime.getCache<unknown>(
    `message-consent:${message.entityId}:${message.roomId}`,
  );
  const now = Date.now();
  if (
    !pendingSend(existing) ||
    !existing.draftId ||
    (existing.consumedBy !== null && existing.consumedBy !== message.id) ||
    existing.messageId === message.id ||
    message.createdAt <= existing.messageTime ||
    now < existing.armedAt ||
    now - existing.armedAt > 5 * 60_000
  )
    return null;
  return existing.draftId;
}

function isAffirmative(text: string, options: SendConsentOptions): boolean {
  if (affirmative.test(text)) return true;
  const normalized = text.toLowerCase();
  return (options.affirmations ?? []).some(
    (value) => value.trim().toLowerCase() === normalized,
  );
}

export async function requireSendConsent(
  runtime: IAgentRuntime,
  message: Memory,
  digest: string,
  options: SendConsentOptions = {},
): Promise<"pending" | "confirmed" | "cancelled"> {
  if (
    !message.id ||
    !message.entityId ||
    !message.roomId ||
    message.entityId === runtime.agentId ||
    typeof message.createdAt !== "number" ||
    !Number.isFinite(message.createdAt)
  ) {
    throw new ElizaError("Send confirmation requires an identified user turn", {
      code: "MESSAGE_CONFIRMATION_TURN_REQUIRED",
    });
  }
  const key = `message-consent:${message.entityId}:${message.roomId}`;
  const existing = await runtime.getCache<unknown>(key);
  const now = Date.now();
  if (pendingSend(existing)) {
    if (existing.consumedBy === message.id) return "cancelled";
    const fresh =
      existing.digest === digest &&
      existing.consumedBy === null &&
      now >= existing.armedAt &&
      now - existing.armedAt <= 5 * 60_000;
    if (fresh) {
      if (
        existing.messageId === message.id ||
        message.createdAt <= existing.messageTime
      )
        return "pending";
      const consumed = await runtime.compareAndSetCache(key, existing, {
        ...existing,
        consumedBy: message.id,
      });
      if (!consumed) return "cancelled";
      return isAffirmative(unwrapUserMessageText(message).trim(), options)
        ? "confirmed"
        : "cancelled";
    }
  }
  const armed = await runtime.compareAndSetCache(key, existing, {
    nonce: randomUUID(),
    digest,
    messageId: message.id,
    messageTime: message.createdAt,
    armedAt: now,
    consumedBy: null,
    ...(options.draftId ? { draftId: options.draftId } : {}),
  } satisfies PendingSend);
  return armed ? "pending" : "cancelled";
}
