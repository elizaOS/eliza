// @vitest-environment jsdom
/**
 * Boundary validation for pending chat turn receipts. Receipts are read back
 * from `localStorage`, which is untrusted persisted input — any extension, any
 * other script on the origin, or a corrupted write from an older build can put
 * arbitrary JSON under these keys.
 *
 * `typeof x === "number"` accepts the non-finite doubles, and JSON can express
 * them: `1e999` parses to `Infinity`. An accepted non-finite `sentAt` then
 * breaks three separate downstream contracts, so the guard belongs at the
 * parse boundary rather than at each consumer.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  listPendingChatTurns,
  PENDING_CHAT_TURN_SETTLE_TIMEOUT_MS,
  persistPendingChatTurn,
} from "./pending-chat-turns";

const CONVERSATION = "conv-validation";
const KEY_PREFIX = "eliza:chat:pending-turn:";

function writeRaw(clientMessageId: string, json: string): void {
  window.localStorage.setItem(
    `${KEY_PREFIX}${CONVERSATION}:${clientMessageId}`,
    json,
  );
}

function receiptJson(clientMessageId: string, sentAt: string): string {
  return `{"conversationId":"${CONVERSATION}","clientMessageId":"${clientMessageId}","text":"draft ${clientMessageId}","sentAt":${sentAt},"restoreAt":${sentAt}}`;
}

describe("pending chat turn receipt validation", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("accepts and orders well-formed receipts oldest first", () => {
    persistPendingChatTurn({
      conversationId: CONVERSATION,
      clientMessageId: "b",
      text: "second",
      sentAt: 2_000,
    });
    persistPendingChatTurn({
      conversationId: CONVERSATION,
      clientMessageId: "a",
      text: "first",
      sentAt: 1_000,
    });
    expect(
      listPendingChatTurns(CONVERSATION).map((r) => r.clientMessageId),
    ).toEqual(["a", "b"]);
  });

  it("rejects a receipt whose sentAt overflows to Infinity", () => {
    // JSON has no Infinity literal, but 1e999 parses to it.
    writeRaw("overflow", receiptJson("overflow", "1e999"));
    expect(listPendingChatTurns(CONVERSATION)).toEqual([]);
  });

  it("rejects a receipt whose sentAt underflows to -Infinity", () => {
    writeRaw("underflow", receiptJson("underflow", "-1e999"));
    expect(listPendingChatTurns(CONVERSATION)).toEqual([]);
  });

  it("does not let a non-finite receipt displace well-formed ones", () => {
    // Infinity - Infinity is NaN, and sort treats a NaN comparator result as
    // "leave as is", so the good receipts stop being ordered by sentAt.
    persistPendingChatTurn({
      conversationId: CONVERSATION,
      clientMessageId: "b",
      text: "second",
      sentAt: 2_000,
    });
    writeRaw("overflow", receiptJson("overflow", "1e999"));
    persistPendingChatTurn({
      conversationId: CONVERSATION,
      clientMessageId: "a",
      text: "first",
      sentAt: 1_000,
    });
    expect(
      listPendingChatTurns(CONVERSATION).map((r) => r.clientMessageId),
    ).toEqual(["a", "b"]);
  });

  it("still accepts a receipt whose restoreAt is the persisted settle window", () => {
    const persisted = persistPendingChatTurn({
      conversationId: CONVERSATION,
      clientMessageId: "c",
      text: "draft",
      sentAt: 5_000,
    });
    expect(persisted.restoreAt).toBe(
      5_000 + PENDING_CHAT_TURN_SETTLE_TIMEOUT_MS,
    );
    expect(listPendingChatTurns(CONVERSATION)).toHaveLength(1);
  });

  it("rejects a receipt whose restoreAt alone is non-finite", () => {
    writeRaw(
      "badrestore",
      `{"conversationId":"${CONVERSATION}","clientMessageId":"badrestore","text":"d","sentAt":1000,"restoreAt":1e999}`,
    );
    expect(listPendingChatTurns(CONVERSATION)).toEqual([]);
  });
});
