/**
 * A cached message created at epoch is a real time. `createdAt || Date.now()`
 * stored it as cached now.
 */

import { describe, expect, spyOn, test } from "bun:test";
import type { UUID } from "@elizaos/core";

import { AgentStateCache } from "./agent-state-cache";
import { cache as cacheClient } from "./client";

describe("room context cache", () => {
  test("keeps a message created at epoch", async () => {
    const set = spyOn(cacheClient, "set").mockResolvedValue(undefined);
    try {
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
      expect(set).toHaveBeenCalledTimes(1);
      const stored = set.mock.calls[0]?.[1] as {
        messages: Array<{ createdAt: number }>;
      };
      expect(stored.messages[0]?.createdAt).toBe(0);
    } finally {
      set.mockRestore();
    }
  });
});
