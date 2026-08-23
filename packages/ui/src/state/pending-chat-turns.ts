/**
 * Durable receipts for chat turns whose browser process can disappear before
 * the stream settles. The active transcript reload owns server truth; these
 * records only keep the composer operable by restoring an unsettled user draft
 * after the bounded recovery window.
 */

import type { ConversationMessage } from "../api";
import { shellLocalStorage } from "../surface-realm-channel";

const PENDING_CHAT_TURN_PREFIX = "eliza:chat:pending-turn:";
export const PENDING_CHAT_TURN_SETTLE_TIMEOUT_MS = 30_000;

export interface PendingChatTurnReceipt {
  conversationId: string;
  clientMessageId: string;
  text: string;
  sentAt: number;
  restoreAt: number;
}

function keyFor(conversationId: string, clientMessageId: string): string {
  return `${PENDING_CHAT_TURN_PREFIX}${conversationId}:${clientMessageId}`;
}

function isReceipt(value: unknown): value is PendingChatTurnReceipt {
  const record = value as Partial<PendingChatTurnReceipt> | null;
  return (
    typeof record?.conversationId === "string" &&
    typeof record.clientMessageId === "string" &&
    typeof record.text === "string" &&
    // Number.isFinite, not typeof: these come back from localStorage, which is
    // untrusted persisted input, and `typeof NaN === "number"` while JSON's
    // `1e999` parses to Infinity. A non-finite stamp survives to break the
    // sentAt ordering (Infinity - Infinity is NaN), the settle comparison in
    // clearSettledPendingChatTurns (`timestamp >= sentAt - 60_000` never holds,
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
  receipt: Omit<PendingChatTurnReceipt, "restoreAt">,
): PendingChatTurnReceipt {
  const complete: PendingChatTurnReceipt = {
    ...receipt,
    restoreAt: receipt.sentAt + PENDING_CHAT_TURN_SETTLE_TIMEOUT_MS,
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

export function clearSettledPendingChatTurns(
  conversationId: string,
  messages: readonly ConversationMessage[],
): void {
  for (const receipt of listPendingChatTurns(conversationId)) {
    const text = receipt.text.trim();
    const settled = messages.some(
      (message) =>
        message.role === "user" &&
        message.timestamp >= receipt.sentAt - 60_000 &&
        message.text.trim() === text,
    );
    if (settled) {
      clearPendingChatTurn(conversationId, receipt.clientMessageId);
    }
  }
}
