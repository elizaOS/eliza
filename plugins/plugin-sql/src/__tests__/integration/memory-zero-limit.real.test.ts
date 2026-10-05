/**
 * An explicit memory page of zero rows must stay empty. `limit: 0` and
 * `count: 0` used to be treated as "no limit" because `0` is falsy, so the
 * read returned every matching row. An omitted limit still returns the
 * complete set.
 */
import {
  ChannelType,
  type Entity,
  type Memory,
  type Room,
  type UUID,
  type World,
} from "@elizaos/core";
import { v4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { MemoryStore } from "../../stores/memory.store";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("memory reads honor an explicit empty page", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testRoomId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("memory_zero_limit");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;
    testRoomId = v4() as UUID;
    const testEntityId = v4() as UUID;
    const testWorldId = v4() as UUID;

    await adapter.createWorld({
      id: testWorldId,
      agentId: testAgentId,
      name: "Zero Limit World",
      serverId: "test-server",
    } as World);
    await adapter.createRooms([
      {
        id: testRoomId,
        agentId: testAgentId,
        worldId: testWorldId,
        name: "Zero Limit Room",
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
    ]);
    await adapter.createEntities([
      {
        id: testEntityId,
        agentId: testAgentId,
        names: ["Zero Limit Entity"],
      } as Entity,
    ]);
    await adapter.addParticipant(testEntityId, testRoomId);

    for (const text of ["first memory", "second memory"]) {
      await adapter.createMemory(
        {
          id: v4() as UUID,
          entityId: testEntityId,
          agentId: testAgentId,
          roomId: testRoomId,
          content: { text },
        } as Memory,
        "messages"
      );
    }
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  function store(): MemoryStore {
    return new MemoryStore({
      getDb: () => adapter.getDatabase() as DrizzleDatabase,
      withRetry: (operation) => operation(),
      withIsolationContext: (entityId, operation) => adapter.withEntityContext(entityId, operation),
      agentId: testAgentId,
      getEmbeddingDimension: () => "dim384",
      getEmbeddingSpace: () => null,
    });
  }

  it("returns no rows for limit 0 and count 0, and the full set when unlimited", async () => {
    const query = { roomId: testRoomId, tableName: "messages" as const };

    expect(await adapter.getMemories({ ...query, limit: 0 })).toEqual([]);
    expect(await adapter.getMemories({ ...query, count: 0 })).toEqual([]);
    expect(
      await adapter.getMemories({
        ...query,
        limit: 0,
        includeEmbedding: false,
      })
    ).toEqual([]);
    expect(await adapter.getMemories({ ...query, limit: 1 })).toHaveLength(1);
    expect(await adapter.getMemories(query)).toHaveLength(2);

    expect(await store().get({ ...query, limit: 0 })).toEqual([]);
    expect(await store().get({ ...query, count: 0 })).toEqual([]);
    expect(
      await store().getByRoomIds({
        roomIds: [testRoomId],
        tableName: "messages",
        limit: 0,
      })
    ).toEqual([]);
    expect(
      await store().getByRoomIds({
        roomIds: [testRoomId],
        tableName: "messages",
      })
    ).toHaveLength(2);
  });
});
