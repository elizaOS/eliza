/**
 * Exercises the real ephemeral adapter's membership CAS under concurrent
 * connector observations so it cannot report two winners for one generation.
 */

import { randomUUID } from "node:crypto";
import type { RoomMembershipEvidence, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

describe("room membership evidence", () => {
  it("serializes competing replacements and preserves exactly one winner", async () => {
    const agentId = randomUUID() as UUID;
    const entityId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    const storage = new MemoryStorage();
    await storage.init();
    const adapter = new InMemoryDatabaseAdapter(storage, agentId);
    await adapter.init();
    await adapter.createRoomParticipants([entityId], roomId);
    const observedAt = Date.now();
    const first: RoomMembershipEvidence = {
      entityId,
      roomId,
      source: "transport:matrix",
      state: "member",
      observedAt,
      expiresAt: observedAt + 60_000,
      generation: 1,
    };
    await expect(
      adapter.updateRoomMembershipEvidence({
        evidence: first,
        expectedGeneration: null,
      })
    ).resolves.toMatchObject({ status: "updated" });

    const results = await Promise.all(
      ["cursor-a", "cursor-b"].map((cursor) =>
        adapter.updateRoomMembershipEvidence({
          evidence: { ...first, cursor, generation: 2 },
          expectedGeneration: 1,
        })
      )
    );
    expect(results.map((result) => result.status).sort()).toEqual(["conflict", "updated"]);
    const current = await adapter.getCurrentRoomMemberships(entityId);
    expect(current).toHaveLength(1);
    expect(["cursor-a", "cursor-b"]).toContain(current[0]?.cursor);
    expect(current[0]?.generation).toBe(2);
  });
});
