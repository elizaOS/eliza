/**
 * Covers malformed room-memory rows during recent conversation backfill.
 * The test uses the exported helper with a minimal runtime double.
 */
import { describe, expect, it } from "vitest";
import { recentConversationTexts } from "./recent-conversation-texts.ts";

describe("recentConversationTexts", () => {
  it("keeps valid memories when one row has no content", async () => {
    const result = await recentConversationTexts({
      runtime: {
        getMemories: async () => [
          { content: undefined },
          { content: { text: "older valid message" } },
        ],
      } as never,
      message: { roomId: "room-1" } as never,
      state: { values: { recentMessages: "current state message" } } as never,
      limit: 3,
    });

    expect(result).toEqual(["older valid message", "current state message"]);
  });

  it("preserves whitespace, speaker prefixes, duplicates, and line boundaries", async () => {
    const exact = "  Owner: first line\n\nsecond line  ";
    const result = await recentConversationTexts({
      runtime: {
        getMemories: async () => [
          { content: { text: exact } },
          { content: { text: exact } },
        ],
      } as never,
      message: { roomId: "room-1" } as never,
      state: { values: { recentMessages: exact } } as never,
    });

    expect(result).toEqual([exact, exact, exact]);
  });

  it("rejects a room-memory read failure instead of returning partial state", async () => {
    const failure = new Error("memory store unavailable");

    await expect(
      recentConversationTexts({
        runtime: { getMemories: async () => Promise.reject(failure) } as never,
        message: { roomId: "room-1" } as never,
        state: { values: { recentMessages: "partial state" } } as never,
      }),
    ).rejects.toBe(failure);
  });
});
