/** Older-page loads must report how many turns were actually prepended. */
import { expect, it } from "vitest";
import type { ConversationMessage } from "../api";
import { loadOlderConversationMessages } from "./load-older-conversation-messages";

function message(id: string, timestamp: number): ConversationMessage {
  return {
    id,
    role: "user",
    text: `turn ${id}`,
    timestamp,
  } as ConversationMessage;
}

it("reports a prepend that dropped rows the thread already held", async () => {
  const result = await loadOlderConversationMessages({
    client: {
      async getConversationMessages() {
        return {
          messages: [message("new", 30), message("already", 40)],
          hasMore: true,
        };
      },
    },
    conversationId: "conversation-1",
    currentMessages: [message("already", 50)],
    prependMessages: (older) =>
      older.filter((entry) => entry.id !== "already").length,
  });
  expect(result).toEqual({ hasMore: true, prependedCount: 1 });
});
