/**
 * Pins the adapter contract the sub-agent entity lifecycle fix (#15102,
 * plugin-agent-orchestrator SubAgentRouter) relies on for the in-memory
 * backend: `deleteParticipants` removes ONLY participant rows, so unlinked
 * entities disappear from `getEntitiesForRooms` (a participants→entities
 * join) while their rows and the memories that reference them survive, and
 * `getEntitiesByIds` still resolves their display names. Runs against a real
 * `InMemoryDatabaseAdapter` + `MemoryStorage`, no mocks. The plugin-sql twin
 * (including the delete-cascade hazard pin) lives in
 * plugin-sql/src/__tests__/integration/sub-agent-entity-unlink.real.test.ts.
 */
import { randomUUID } from "node:crypto";
import type { Entity, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

describe("deleteParticipants unlinks without deleting (#15102)", () => {
  it("hides legacy sub-agent entities from the room read while entity rows and memories survive", async () => {
    const agentId = randomUUID() as UUID;
    const storage = new MemoryStorage();
    await storage.init();
    const adapter = new InMemoryDatabaseAdapter(storage, agentId);
    await adapter.init();

    const roomId = randomUUID() as UUID;
    await adapter.createRooms([
      { id: roomId, agentId, name: "room", source: "test", type: "GROUP" } as never,
    ]);

    const legacy: Entity[] = [0, 1].map((n) => ({
      id: randomUUID() as UUID,
      agentId,
      names: [`sub-agent: old task ${n}`],
      metadata: {
        sub_agent: { subAgentSessionId: randomUUID(), subAgentAgentType: "codex" },
      },
    }));
    const human: Entity = { id: randomUUID() as UUID, agentId, names: ["nubs"] };
    await adapter.createEntities([...legacy, human]);
    await adapter.createRoomParticipants(
      [...legacy, human].map((e) => e.id as UUID),
      roomId
    );
    await adapter.createMemories(
      legacy.map((entity) => ({
        memory: {
          id: randomUUID() as UUID,
          entityId: entity.id as UUID,
          agentId,
          roomId,
          content: { text: `transcript of ${entity.names[0]}` },
        },
        tableName: "memories",
      }))
    );

    const before = (await adapter.getEntitiesForRooms([roomId]))[0]?.entities ?? [];
    expect(before).toHaveLength(3);

    await adapter.deleteParticipants(
      legacy.map((entity) => ({ entityId: entity.id as UUID, roomId }))
    );

    // Room read excludes the unlinked entities…
    const after = (await adapter.getEntitiesForRooms([roomId]))[0]?.entities ?? [];
    expect(after.map((e) => e.names[0])).toEqual(["nubs"]);
    // …but the entity rows survive with their original names (transcript
    // author backfill reads the entities table directly, not the join)…
    const rows = await adapter.getEntitiesByIds(legacy.map((e) => e.id as UUID));
    expect(rows.map((r) => r.names[0]).sort()).toEqual([
      "sub-agent: old task 0",
      "sub-agent: old task 1",
    ]);
    // …and the memories that reference them are untouched.
    const memories = await adapter.getMemories({ tableName: "memories", roomId });
    expect(memories).toHaveLength(2);
    expect(new Set(memories.map((m) => m.entityId))).toEqual(new Set(legacy.map((e) => e.id)));
  });
});
