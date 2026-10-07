/**
 * A cached message created at epoch is a real time. `createdAt || Date.now()`
 * stored it as cached now.
 */

import { describe, expect, mock, test } from "bun:test";
import type { UUID } from "@elizaos/core";

const sets: Array<{ messages: Array<{ createdAt: number }> }> = [];

mock.module("./client", () => ({
  cache: {
    set: async (_key: string, value: { messages: Array<{ createdAt: number }> }) => {
      sets.push(value);
    },
    get: async () => null,
  },
}));

const { AgentStateCache } = await import("./agent-state-cache");

describe("room context cache", () => {
  test("keeps a message created at epoch", async () => {
    sets.length = 0;
    const cache = new AgentStateCache();
    await cache.setRoomContext("room-1", {
      roomId: "room-1",
      messages: [
        {
          id: "00000000-0000-4000-8000-000000000001" as UUID,
          entityId: "00000000-0000-4000-8000-000000000002" as UUID,
          agentId: "00000000-0000-4000-8000-000000000003" as UUID,
          roomId: "room-1" as UUID,
          content: { text: "hi" },
          createdAt: 0,
        },
      ],
      participants: [],
      metadata: {},
      lastActivity: new Date("2024-01-01T00:00:00.000Z"),
    });
    expect(sets).toHaveLength(1);
    expect(sets[0]?.messages[0]?.createdAt).toBe(0);
  });
});
