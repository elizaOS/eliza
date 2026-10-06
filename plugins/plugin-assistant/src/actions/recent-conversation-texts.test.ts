/**
 * Covers lossless recent conversation backfill through the agent-facing core
 * re-export, including malformed rows and repeated storage/state occurrences.
 */

import {
  ChannelType,
  recentConversationTexts,
  stringToUuid,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { describe, expect, it, vi } from "vitest";

describe("recentConversationTexts", () => {
  it("returns stored room history oldest-first", async () => {
    const runtime = createSQLiteTestRuntime({
      character: { name: "Planner", bio: "test" },
      logLevel: "fatal",
    });
    await runtime.adapter.initialize();
    const roomId = stringToUuid("recent-texts-room");
    const ownerId = stringToUuid("recent-texts-owner");
    const worldId = stringToUuid("recent-texts-world");
    await runtime.createEntities([
      { id: ownerId, agentId: runtime.agentId, names: ["Owner"] },
    ]);
    await runtime.createWorlds([
      {
        id: worldId,
        agentId: runtime.agentId,
        name: "Home",
        serverId: worldId,
      },
    ]);
    await runtime.createRooms([
      {
        id: roomId,
        agentId: runtime.agentId,
        worldId,
        name: "Owner DM",
        source: "client_chat",
        type: ChannelType.DM,
      },
    ]);
    const turns = ["remind me at 4pm", "actually make it 5pm"];
    for (const [index, text] of turns.entries()) {
      await runtime.createMemory(
        {
          id: stringToUuid(`recent-texts-${index}`),
          agentId: runtime.agentId,
          entityId: ownerId,
          roomId,
          createdAt: 1_000 + index,
          content: { text, source: "client_chat" },
        },
        "messages",
      );
    }

    const result = await recentConversationTexts({
      runtime,
      message: { roomId } as never,
      state: undefined,
    });

    expect(result).toEqual(turns);

    // No default read window: a long room comes back whole and in order, so
    // ascending order cannot select the oldest page instead of the newest.
    const longTurns = Array.from(
      { length: 120 },
      (_, index) => `turn ${index}`,
    );
    for (const [index, text] of longTurns.entries()) {
      await runtime.createMemory(
        {
          id: stringToUuid(`recent-texts-long-${index}`),
          agentId: runtime.agentId,
          entityId: ownerId,
          roomId,
          createdAt: 2_000 + index,
          content: { text, source: "client_chat" },
        },
        "messages",
      );
    }
    expect(
      await recentConversationTexts({
        runtime,
        message: { roomId } as never,
        state: undefined,
      }),
    ).toEqual([...turns, ...longTurns]);
  });

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
