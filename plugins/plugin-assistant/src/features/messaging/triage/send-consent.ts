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
    (record.consumedBy === null || typeof record.consumedBy === "string")
  );
}

export async function requireSendConsent(
  runtime: IAgentRuntime,
  message: Memory,
  digest: string,
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
      return affirmative.test(unwrapUserMessageText(message).trim())
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
  } satisfies PendingSend);
  return armed ? "pending" : "cancelled";
}
