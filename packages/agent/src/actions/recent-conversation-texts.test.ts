/**
 * Covers lossless recent conversation backfill through the agent-facing core
 * re-export, including malformed rows and repeated storage/state occurrences.
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

    expect(result).toEqual(["repeat this", "repeat this", "repeat this"]);
  });
});
