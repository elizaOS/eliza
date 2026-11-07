import { beforeEach, expect, test, vi } from "vitest";
import type { ConversationMessage } from "../api/client-types-chat";
import { countSentUserTurns, sentUserTurnPresent } from "./chat-send-failures";
import {
  clearSettledPendingChatTurns,
  listPendingChatTurns,
  persistPendingChatTurn,
} from "./pending-chat-turns";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("window", {
    localStorage: {
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
    },
    dispatchEvent: () => true,
  });
});

const conversationId = "c0ffee00-0000-4000-8000-000000000001";
const firstAt = Date.parse("2026-10-30T12:00:00Z");
const resendAt = firstAt + 25_000;
// The user said "yes", got a reply, and said "yes" again 25s later.
const beforeResend: ConversationMessage[] = [
  { id: "u1", role: "user", text: "yes", timestamp: firstAt },
  { id: "a1", role: "assistant", text: "Done.", timestamp: firstAt + 5_000 },
];
const withResend: ConversationMessage[] = [
  ...beforeResend,
  { id: "u2", role: "user", text: "yes", timestamp: resendAt },
];

test("an earlier identical turn does not count as the resend", () => {
  const priorMatches = countSentUserTurns(beforeResend, "yes", resendAt);
  expect(priorMatches).toBe(1);
  expect(sentUserTurnPresent(beforeResend, "yes", resendAt, priorMatches)).toBe(
    false,
  );
  expect(sentUserTurnPresent(withResend, "yes", resendAt, priorMatches)).toBe(
    true,
  );
});

test("a pending resend stays unsettled until its own row is in history", () => {
  persistPendingChatTurn({
    conversationId,
    clientMessageId: "turn-2",
    text: "yes",
    sentAt: resendAt,
    priorMatches: countSentUserTurns(beforeResend, "yes", resendAt),
  });
  clearSettledPendingChatTurns(conversationId, beforeResend);
  expect(
    listPendingChatTurns(conversationId).map((r) => r.clientMessageId),
  ).toEqual(["turn-2"]);
  clearSettledPendingChatTurns(conversationId, withResend);
  expect(listPendingChatTurns(conversationId)).toEqual([]);
});
