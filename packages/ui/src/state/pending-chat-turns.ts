/**
 * Durable receipts for chat turns whose browser process can disappear before
 * the stream settles. The active transcript reload owns server truth; these
 * records only keep the composer operable by restoring an unsettled user draft
 * after the bounded recovery window.
 */

import type { ConversationMessage } from "../api/client-types-chat";
import { shellLocalStorage } from "../surface-realm-channel";

const PENDING_CHAT_TURN_PREFIX = "eliza:chat:pending-turn:";
export const PENDING_CHAT_TURN_SETTLE_TIMEOUT_MS = 30_000;
export const PENDING_CHAT_TURN_SETTLED_EVENT =
  "eliza:chat:pending-turn-settled";

export interface PendingChatTurnReceipt {
  conversationId: string;
  clientMessageId: string;
  text: string;
  sentAt: number;
  restoreAt: number;
  restoredToDraft?: boolean;
  /**
   * Ids of user rows already in the thread when this receipt was written. None
   * of them can be this turn. Receipts from older builds have none.
   */
  knownUserMessageIds?: string[];
}

/** Clock skew allowed between the local send time and the server's row stamp. */
export const PENDING_CHAT_TURN_CLOCK_SKEW_MS = 5_000;
/** Match window for receipts written without `knownUserMessageIds`. */
const LEGACY_PENDING_CHAT_TURN_SLACK_MS = 60_000;

function keyFor(conversationId: string, clientMessageId: string): string {
  return `${PENDING_CHAT_TURN_PREFIX}${conversationId}:${clientMessageId}`;
}

function isReceipt(value: unknown): value is PendingChatTurnReceipt {
  const record = value as Partial<PendingChatTurnReceipt> | null;
  return (
    typeof record?.conversationId === "string" &&
    typeof record.clientMessageId === "string" &&
    typeof record.text === "string" &&
    (record.restoredToDraft === undefined ||
      typeof record.restoredToDraft === "boolean") &&
    (record.knownUserMessageIds === undefined ||
      (Array.isArray(record.knownUserMessageIds) &&
        record.knownUserMessageIds.every((id) => typeof id === "string"))) &&
    // Number.isFinite, not typeof: these come back from localStorage, which is
    // untrusted persisted input, and `typeof NaN === "number"` while JSON's
    // `1e999` parses to Infinity. A non-finite stamp survives to break the
    // sentAt ordering (Infinity - Infinity is NaN), the settle comparison in
    // clearSettledPendingChatTurns (`timestamp >= sentAt - slack` never holds,
    // so the receipt is never cleared), and the restore delay derived from
    // restoreAt. Rejecting it here keeps that guard in one place.
    Number.isFinite(record.sentAt) &&
    Number.isFinite(record.restoreAt) &&
    record.conversationId.length > 0 &&
    record.clientMessageId.length > 0
  );
}

function readReceipt(raw: string | null): PendingChatTurnReceipt | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isReceipt(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function persistPendingChatTurn(
  receipt: Omit<PendingChatTurnReceipt, "restoreAt" | "restoredToDraft">,
): PendingChatTurnReceipt {
  const previous = listPendingChatTurns(receipt.conversationId).find(
    (pending) => pending.clientMessageId === receipt.clientMessageId,
  );
  const complete: PendingChatTurnReceipt = {
    ...receipt,
    restoreAt: receipt.sentAt + PENDING_CHAT_TURN_SETTLE_TIMEOUT_MS,
    ...(previous?.restoredToDraft && previous.text === receipt.text
      ? { restoredToDraft: true }
      : {}),
  };
  if (typeof window === "undefined") return complete;
  try {
    shellLocalStorage.setItem(
      keyFor(complete.conversationId, complete.clientMessageId),
      JSON.stringify(complete),
    );
  } catch {
    // error-policy:J3 storage can be unavailable; the live send still owns the
    // turn, and the receipt is only a reload recovery aid.
    return complete;
  }
  return complete;
}

/** Only the recovery flow may associate a draft with an uncertain send. */
export function markPendingChatTurnRestored(
  conversationId: string,
  clientMessageId: string,
): boolean {
  const receipt = listPendingChatTurns(conversationId).find(
    (pending) => pending.clientMessageId === clientMessageId,
  );
  if (!receipt) return false;
  try {
    shellLocalStorage.setItem(
      keyFor(conversationId, clientMessageId),
      JSON.stringify({ ...receipt, restoredToDraft: true }),
    );
    return true;
  } catch {
    // error-policy:J3 Do not restore a retry draft without its identity: submitting it could
    // repeat an already accepted effect. Canonical history can still settle it.
    return false;
  }
}

/** Editing releases draft ownership without losing the uncertain send receipt. */
export function releasePendingChatTurnDraft(
  conversationId: string,
  clientMessageId: string,
): void {
  const receipt = listPendingChatTurns(conversationId).find(
    (pending) => pending.clientMessageId === clientMessageId,
  );
  if (!receipt?.restoredToDraft) return;
  try {
    shellLocalStorage.setItem(
      keyFor(conversationId, clientMessageId),
      JSON.stringify({ ...receipt, restoredToDraft: false }),
    );
  } catch {
    // error-policy:J3 Storage may be unavailable; the mounted composer also releases its owner.
  }
}

export function clearPendingChatTurn(
  conversationId: string,
  clientMessageId: string,
): void {
  if (typeof window === "undefined") return;
  try {
    shellLocalStorage.removeItem(keyFor(conversationId, clientMessageId));
  } catch {
    // error-policy:J3 storage can be unavailable; an uncleared receipt expires
    // into a draft restore rather than fabricating chat state.
    return;
  }
}

export function listPendingChatTurns(
  conversationId: string,
): PendingChatTurnReceipt[] {
  if (typeof window === "undefined") return [];
  const receipts: PendingChatTurnReceipt[] = [];
  const prefix = `${PENDING_CHAT_TURN_PREFIX}${conversationId}:`;
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const receipt = readReceipt(window.localStorage.getItem(key));
      if (receipt) receipts.push(receipt);
    }
  } catch {
    return [];
  }
  return receipts.sort((a, b) => a.sentAt - b.sentAt);
}

/**
 * True when `messages` holds the user row of a send made at `sentAt`. A row
 * whose id was already known at send time is an earlier message, even with
 * the same text. Without known ids the older 60 s window applies.
 */
export function pendingUserTurnPresent(
  messages: readonly ConversationMessage[],
  sentText: string,
  sentAt: number,
  knownUserMessageIds?: readonly string[],
): boolean {
  const text = sentText.trim();
  const known = knownUserMessageIds ? new Set(knownUserMessageIds) : null;
  const earliest =
    sentAt -
    (known
      ? PENDING_CHAT_TURN_CLOCK_SKEW_MS
      : LEGACY_PENDING_CHAT_TURN_SLACK_MS);
  return messages.some(
    (message) =>
      message.role === "user" &&
      !known?.has(message.id) &&
      message.timestamp >= earliest &&
      message.text.trim() === text,
  );
}

/** Clears a receipt and tells a composer holding its restored draft. */
export function settlePendingChatTurn(
  conversationId: string,
  clientMessageId: string,
): void {
  const receipt = listPendingChatTurns(conversationId).find(
    (pending) => pending.clientMessageId === clientMessageId,
  );
  clearPendingChatTurn(conversationId, clientMessageId);
  if (receipt?.restoredToDraft === true && typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(PENDING_CHAT_TURN_SETTLED_EVENT, {
        detail: {
          conversationId,
          clientMessageId: receipt.clientMessageId,
          text: receipt.text,
        },
      }),
    );
  }
}

export function clearSettledPendingChatTurns(
  conversationId: string,
  messages: readonly ConversationMessage[],
): void {
  for (const receipt of listPendingChatTurns(conversationId)) {
    if (
      pendingUserTurnPresent(
        messages,
        receipt.text,
        receipt.sentAt,
        receipt.knownUserMessageIds,
      )
    ) {
      settlePendingChatTurn(conversationId, receipt.clientMessageId);
    }
  }
}
