/** Exercises room entity batching against real persisted SQL, including query counts and the graph consumer. */
import { randomUUID } from "node:crypto";
import { ChannelType, type UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createNativeRelationshipsGraphService } from "../../../../plugin-assistant/src/services/relationships-graph-builder";
import { componentTable } from "../../schema/component";
import { entityTable } from "../../schema/entity";
import { participantTable } from "../../schema/participant";
import { createIsolatedTestDatabase } from "../test-helpers";

const uuid = () => randomUUID() as UUID;

describe("room entity SQL batch", () => {
  let setup: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  const rooms = [uuid(), uuid(), uuid()];
  const alice = uuid();
  const bob = uuid();
  const foreign = uuid();
  const foreignAgent = uuid();
  const componentIds = [uuid(), uuid()];
  let reads: string[] = [];
  let restoreQueries: () => void;

  beforeAll(async () => {
    setup = await createIsolatedTestDatabase("room-entity-batch");
    const { adapter, testAgentId, runtime } = setup;
    const world = uuid();
    await runtime.createWorld({ id: world, agentId: testAgentId, name: "Graph workspace" });
    await adapter.createRooms(
      rooms.map((id) => ({
        id,
        agentId: testAgentId,
        worldId: world,
        source: "test",
        type: ChannelType.GROUP,
      }))
    );
    await adapter.createAgent({ id: foreignAgent, name: "Other agent" });
    await adapter.db.insert(entityTable).values([
      { id: alice, agentId: testAgentId, names: ["Alice"], metadata: { complete: "preserved" } },
      { id: bob, agentId: testAgentId, names: ["Bob"] },
      { id: foreign, agentId: foreignAgent, names: ["Foreign"] },
    ]);
    await adapter.db.insert(participantTable).values([
      { entityId: alice, roomId: rooms[0], agentId: foreignAgent },
      { entityId: alice, roomId: rooms[0], agentId: testAgentId },
      { entityId: bob, roomId: rooms[0], agentId: testAgentId },
      { entityId: foreign, roomId: rooms[0], agentId: foreignAgent },
      { entityId: alice, roomId: rooms[1], agentId: testAgentId },
    ]);
    await adapter.db.insert(componentTable).values(
      componentIds.map((id, index) => ({
        id,
        entityId: alice,
        agentId: index ? foreignAgent : testAgentId,
        roomId: rooms[index],
        type: `profile-${index}`,
        data: { value: index },
      }))
    );
    // Pass-through instrumentation observes actual driver execution, never substitutes query results.
    const connection = adapter.getRawConnection();
    const original = connection.query.bind(connection);
    const observer = vi
      .spyOn(connection, "query")
      .mockImplementation((...args: Parameters<typeof connection.query>) => {
        const query = typeof args[0] === "string" ? args[0] : args[0].text;
        if (/\bparticipants\b/i.test(query) && /\bentities\b/i.test(query)) reads.push(query);
        return original(...args);
      });
    restoreQueries = () => observer.mockRestore();
  });

  afterAll(async () => {
    restoreQueries?.();
    await setup?.cleanup();
  });

  it.each([false, true])(
    "preserves grouping, duplicates, UUID spelling and joins with components=%s in one SELECT",
    async (includeComponents) => {
      const ids = [rooms[1], rooms[0].toUpperCase() as UUID, uuid(), rooms[2], rooms[0]];
      reads = [];
      const results = await setup.adapter.getEntitiesForRooms(ids, includeComponents);
      expect(results.map((row) => row.roomId)).toEqual(ids);
      expect(results.map((row) => row.entities.map((entity) => entity.id).sort())).toEqual([
        [alice],
        [alice, bob].sort(),
        [],
        [],
        [alice, bob].sort(),
      ]);
      for (const [index, row] of results.entries()) {
        for (const entity of row.entities) {
          expect(entity.agentId).toBe(setup.testAgentId);
          expect(entity).toEqual(expect.objectContaining({ createdAt: expect.any(Date) }));
          if (entity.id === alice) {
            expect(entity.metadata).toEqual({ complete: "preserved" });
            expect(entity.names).toEqual(["Alice"]);
          }
          if (!includeComponents) expect(entity.components).toBeUndefined();
          else if (entity.id === bob) expect(entity.components).toEqual([]);
          else
            expect(entity.components?.map((component) => component.id).sort()).toEqual(
              (index === 0 ? componentIds : [...componentIds, ...componentIds]).sort()
            );
        }
      }
      const firstAlice = results[1].entities.find((entity) => entity.id === alice);
      const repeatedAlice = results[4].entities.find((entity) => entity.id === alice);
      expect(firstAlice).toBeDefined();
      expect(repeatedAlice).toBeDefined();
      if (!firstAlice || !repeatedAlice) throw new Error("Seeded Alice was not returned");
      const repeatedBefore = structuredClone(repeatedAlice);
      firstAlice.names.push("changed locally");
      if (!firstAlice.metadata) throw new Error("Seeded metadata was not returned");
      firstAlice.metadata.complete = "changed locally";
      if (includeComponents) {
        const component = firstAlice.components?.[0];
        if (!component) throw new Error("Seeded component was not returned");
        component.data.value = "changed locally";
      }
      expect(repeatedAlice).toEqual(repeatedBefore);
      results[1].entities.pop();
      expect(results[4].entities).toHaveLength(2);
      expect(reads).toHaveLength(1);
    }
  );

  it("does not query empty input and rejects invalid UUIDs without partial results", async () => {
    reads = [];
    expect(await setup.adapter.getEntitiesForRooms([], true)).toEqual([]);
    expect(reads).toEqual([]);
    await expect(
      setup.adapter.getEntitiesForRooms([rooms[0], "not-a-uuid" as UUID])
    ).rejects.toThrow();
  });

  it("propagates a real SQL failure instead of fabricating empty groups", async () => {
    await setup.adapter.db.execute(
      sql`ALTER TABLE participants RENAME TO participants_batch_unavailable`
    );
    try {
      await expect(setup.adapter.getEntitiesForRooms([rooms[0]])).rejects.toThrow();
    } finally {
      await setup.adapter.db.execute(
        sql`ALTER TABLE participants_batch_unavailable RENAME TO participants`
      );
    }
  });

  it("builds the actual graph from all persisted rooms with one room-entity SELECT", async () => {
    await setup.adapter.createEntities([
      { id: setup.testAgentId, agentId: setup.testAgentId, names: ["Agent self"] },
    ]);
    await setup.adapter.addParticipantsRoom([setup.testAgentId], rooms[0]);
    reads = [];
    const service = createNativeRelationshipsGraphService(setup.runtime, {});
    const snapshot = await service.getGraphSnapshot();
    expect(snapshot.people.map((person) => person.primaryEntityId).sort()).toEqual(
      [alice, bob].sort()
    );
    expect(reads).toHaveLength(1);
  });
});
