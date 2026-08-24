/**
 * Covers lossless recent conversation backfill through the agent-facing core
 * re-export, including malformed rows and repeated storage/state occurrences.
 */
import { describe, expect, it, vi } from "vitest";
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

  it("preserves identical turns from storage and canonical provider state", async () => {
    const result = await recentConversationTexts({
      runtime: {
        getMemories: async () => [
          { id: "stored-turn", content: { text: "User: repeat this" } },
        ],
        reportError: () => undefined,
      } as never,
      message: { roomId: "room-1" } as never,
      state: {
        values: { recentMessages: "User: repeat this" },
        data: {
          providers: {
            RECENT_MESSAGES: {
              data: {
                recentMessages: [
                  {
                    id: "provider-turn",
                    content: { text: "User: repeat this" },
                  },
                ],
              },
            },
          },
        },
      } as never,
    });

    expect(result).toEqual([
      "User: repeat this",
      "User: repeat this",
      "User: repeat this",
    ]);
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
    const reportError = vi.fn();

    await expect(
      recentConversationTexts({
        runtime: {
          getMemories: async () => Promise.reject(failure),
          reportError,
        } as never,
        message: { roomId: "room-1" } as never,
        state: { values: { recentMessages: "partial state" } } as never,
      }),
    ).rejects.toBe(failure);
    expect(reportError).toHaveBeenCalledWith(
      "RecentContext.getMemories",
      failure,
      { roomId: "room-1" },
    );
  });
});
