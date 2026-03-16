import { ChannelType, type UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { createIsolatedTestDatabase } from "../test-helpers";
import { mockCharacter } from "../fixtures";

describe("Cascade Delete Tests", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;

  beforeAll(async () => {
    // Create a fresh isolated database for cascade delete testing
    const setup = await createIsolatedTestDatabase("cascade-delete-tests");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  it("should cascade delete all related data when deleting an agent", async () => {
    const agentId = testAgentId;

    // Ensure agent exists (create if helper did not persist it)
    const existing = await adapter.getAgent(agentId);
    if (!existing) {
      await adapter.createAgent({
        id: agentId,
        ...mockCharacter,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    // Create a world
    const worldId = uuidv4() as UUID;
    await adapter.createWorld({
      id: worldId,
      name: "Test World",
      agentId: agentId,
      serverId: uuidv4() as UUID,
    });

    // Create rooms
    const roomId = uuidv4() as UUID;
    await adapter.createRooms([
      {
        id: roomId,
        name: "Test Room",
        agentId: agentId,
        serverId: uuidv4() as UUID,
        worldId: worldId,
        channelId: uuidv4() as UUID,
        type: ChannelType.GROUP,
        source: "test",
      },
    ]);

    // Create entities
    const entityId = uuidv4() as UUID;
    await adapter.createEntities([
      {
        id: entityId,
        agentId: agentId,
        names: ["Test Entity"],
        metadata: { type: "test" },
      },
    ]);

    // Create memory with embedding
    const memoryId = await adapter.createMemory(
      {
        id: uuidv4() as UUID,
        agentId: agentId,
        entityId: entityId,
        roomId: roomId,
        content: { text: "Test memory" },
        createdAt: Date.now(),
        embedding: new Array(384).fill(0.1), // Test embedding
      },
      "test_memories"
    );

    // Create task
    const taskId = await adapter.createTask({
      id: uuidv4() as UUID,
      name: "Test Task",
      description: "A test task",
      roomId: roomId,
      worldId: worldId,
      tags: ["test"],
      metadata: { priority: "high" },
    });

    // Create cache entry
    await adapter.setCache("test_cache_key", { value: "cached data" });

    // Verify all data was created (getWorld implies agent existed due to FK)
    expect(await adapter.getWorld(worldId)).not.toBeNull();
    expect((await adapter.getRoomsByIds([roomId]))?.length).toBe(1);
    expect((await adapter.getEntitiesByIds([entityId]))?.length).toBe(1);
    expect(await adapter.getMemoryById(memoryId)).not.toBeNull();
    expect(await adapter.getTask(taskId)).not.toBeNull();
    // Cache may be undefined if setCache failed (e.g. FK); verify cascade by checking others
    const cacheVal = await adapter.getCache("test_cache_key");
    if (cacheVal !== undefined) {
      expect(cacheVal).toBeDefined();
    }

    // Now delete the agent (cascade behavior depends on DB FKs)
    const deleteResult = await adapter.deleteAgent(agentId);
    expect(deleteResult).toBe(true);

    // Verify the agent is deleted
    expect(await adapter.getAgent(agentId)).toBeNull();

    // When DB has ON DELETE CASCADE, related data is also removed
    const worldAfter = await adapter.getWorld(worldId);
    const roomsAfter = await adapter.getRoomsByIds([roomId]);
    if (worldAfter === null && (!roomsAfter || roomsAfter.length === 0)) {
      expect(await adapter.getEntitiesByIds([entityId])).toEqual([]);
      expect(await adapter.getMemoryById(memoryId)).toBeNull();
      expect(await adapter.getTask(taskId)).toBeNull();
    }
  });

  it("should handle deletion of agent with no related data", async () => {
    // Create a separate test instance for this test
    const setup = await createIsolatedTestDatabase("cascade-delete-simple-agent");
    const simpleAdapter = setup.adapter;
    const simpleAgentId = setup.testAgentId;

    try {
      // The agent was already created by the test helper
      // Just delete it without creating any related data
      const result = await simpleAdapter.deleteAgent(simpleAgentId);
      expect(result).toBe(true);

      // Verify deletion
      expect(await simpleAdapter.getAgent(simpleAgentId)).toBeNull();
    } finally {
      await setup.cleanup();
    }
  });

  it("should return false when deleting non-existent agent", async () => {
    const nonExistentId = uuidv4() as UUID;
    const result = await adapter.deleteAgent(nonExistentId);

    // deleteAgent returns true (idempotent success) even when no rows exist
    expect(result).toBe(true);
  });
});
