/**
 * Pins that the two LIMIT/OFFSET reads of the SQL adapter, `getRoomsByWorlds`
 * and `getRelationships`, walk a stable order, against a real isolated PGlite
 * (or Postgres) adapter with no mocks. Without an ORDER BY the pages follow
 * heap order, which moves on any UPDATE, so a walk that updates a row between
 * pages drops one row and serves another twice.
 */
import { ChannelType, type Entity, type Room, type UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../pg/adapter";
import type { PgliteDatabaseAdapter } from "../pglite/adapter";
import { createIsolatedTestDatabase } from "./test-helpers";

const PAGE_SIZE = 1;

describe("paginated reads keep a stable order across an UPDATE", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testWorldId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("paginated-reads-stable-order");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;
    testWorldId = uuidv4() as UUID;
    await adapter.createWorld({
      id: testWorldId,
      agentId: testAgentId,
      name: "Paging World",
      messageServerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID,
    });
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it("getRoomsByWorlds serves every room exactly once when one is updated between pages (#31976)", async () => {
    const rooms: Room[] = Array.from({ length: 4 }, (_, index) => ({
      id: uuidv4() as UUID,
      agentId: testAgentId,
      worldId: testWorldId,
      name: `room-${index}`,
      source: "test",
      type: ChannelType.GROUP,
    })) as Room[];
    // Separate inserts so the rows carry distinct creation instants.
    for (const room of rooms) {
      await adapter.createRooms([room]);
    }

    const firstPage = await adapter.getRoomsByWorlds([testWorldId], PAGE_SIZE, 0);
    expect(firstPage).toHaveLength(1);
    // Rewriting the row already served moves it in the heap; the walk must not care.
    await adapter.updateRoom({ ...firstPage[0], name: `${firstPage[0].name}-updated` });

    const seen = [firstPage[0].id];
    for (let offset = PAGE_SIZE; offset < rooms.length; offset += PAGE_SIZE) {
      const page = await adapter.getRoomsByWorlds([testWorldId], PAGE_SIZE, offset);
      expect(page).toHaveLength(1);
      seen.push(page[0].id);
    }
    expect(new Set(seen).size).toBe(rooms.length);
    expect([...seen].sort()).toEqual(rooms.map((room) => room.id).sort());
    expect(await adapter.getRoomsByWorlds([testWorldId], PAGE_SIZE, rooms.length)).toEqual([]);
  });

  it("getRelationships serves every relationship exactly once when one is updated between pages (#31976)", async () => {
    const sourceId = uuidv4() as UUID;
    const targetIds = Array.from({ length: 4 }, () => uuidv4() as UUID);
    await adapter.createEntities([
      { id: sourceId, agentId: testAgentId, names: ["source"] } as Entity,
      ...targetIds.map(
        (id, index) => ({ id, agentId: testAgentId, names: [`target-${index}`] }) as Entity
      ),
    ]);
    for (const [index, targetEntityId] of targetIds.entries()) {
      expect(
        await adapter.createRelationship({
          sourceEntityId: sourceId,
          targetEntityId,
          tags: [`pair-${index}`],
        })
      ).toBe(true);
    }

    const firstPage = await adapter.getRelationships({
      entityId: sourceId,
      limit: PAGE_SIZE,
      offset: 0,
    });
    expect(firstPage).toHaveLength(1);
    await adapter.updateRelationship({
      ...firstPage[0],
      tags: [...firstPage[0].tags, "touched"],
    });

    const seen = [firstPage[0].id];
    for (let offset = PAGE_SIZE; offset < targetIds.length; offset += PAGE_SIZE) {
      const page = await adapter.getRelationships({
        entityId: sourceId,
        limit: PAGE_SIZE,
        offset,
      });
      expect(page).toHaveLength(1);
      seen.push(page[0].id);
    }
    expect(new Set(seen).size).toBe(targetIds.length);
    const all = await adapter.getRelationships({ entityId: sourceId });
    expect([...seen].sort()).toEqual(all.map((relationship) => relationship.id).sort());
    expect(
      await adapter.getRelationships({
        entityId: sourceId,
        limit: PAGE_SIZE,
        offset: targetIds.length,
      })
    ).toEqual([]);
  });
});
