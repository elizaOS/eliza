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
import { createIsolatedTestDatabase } from "../test-helpers";

/**
 * Every memory READ path must return the stored `worldId`.
 *
 * Pre-fix, only searchMemoriesByEmbedding mapped `worldId` back onto the
 * returned Memory; getMemories / getMemoriesByRoomIds / getMemoryById /
 * getMemoriesByIds silently dropped it, so consumers that round-trip a
 * fetched memory (e.g. agent-export -> restore, which remaps `mem.worldId`)
 * permanently lost every memory→world association.
 */
describe("Memory worldId round-trip", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testRoomId: UUID;
  let testEntityId: UUID;
  let testWorldId: UUID;
  let memoryId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("memory_worldid_tests");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    testRoomId = v4() as UUID;
    testEntityId = v4() as UUID;
    testWorldId = v4() as UUID;

    await adapter.createWorld({
      id: testWorldId,
      agentId: testAgentId,
      name: "WorldId Test World",
      serverId: "test-server",
    } as World);
    await adapter.createRooms([
      {
        id: testRoomId,
        agentId: testAgentId,
        worldId: testWorldId,
        name: "WorldId Test Room",
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
    ]);
    await adapter.createEntities([
      {
        id: testEntityId,
        agentId: testAgentId,
        names: ["WorldId Test Entity"],
      } as Entity,
    ]);
    await adapter.addParticipant(testEntityId, testRoomId);

    memoryId = await adapter.createMemory(
      {
        id: v4() as UUID,
        entityId: testEntityId,
        agentId: testAgentId,
        roomId: testRoomId,
        worldId: testWorldId,
        content: { text: "memory with a world" },
      } as Memory,
      "messages"
    );
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  it("getMemories returns worldId (embedding branch)", async () => {
    const memories = await adapter.getMemories({
      tableName: "messages",
      roomId: testRoomId,
    });
    expect(memories).toHaveLength(1);
    expect(memories[0].worldId).toBe(testWorldId);
  });

  it("getMemories returns worldId (includeEmbedding: false branch)", async () => {
    const memories = await adapter.getMemories({
      tableName: "messages",
      roomId: testRoomId,
      includeEmbedding: false,
    });
    expect(memories).toHaveLength(1);
    expect(memories[0].worldId).toBe(testWorldId);
  });

  it("getMemories filtered by worldId returns rows that carry that worldId", async () => {
    const memories = await adapter.getMemories({
      tableName: "messages",
      worldId: testWorldId,
    });
    expect(memories).toHaveLength(1);
    expect(memories[0].worldId).toBe(testWorldId);
  });

  it("getMemoryById returns worldId", async () => {
    const memory = await adapter.getMemoryById(memoryId);
    expect(memory).not.toBeNull();
    expect(memory?.worldId).toBe(testWorldId);
  });

  it("getMemoriesByIds returns worldId", async () => {
    const memories = await adapter.getMemoriesByIds([memoryId], "messages");
    expect(memories).toHaveLength(1);
    expect(memories[0].worldId).toBe(testWorldId);
  });

  it("getMemoriesByRoomIds returns worldId", async () => {
    const memories = await adapter.getMemoriesByRoomIds({
      roomIds: [testRoomId],
      tableName: "messages",
    });
    expect(memories).toHaveLength(1);
    expect(memories[0].worldId).toBe(testWorldId);
  });

  it("keeps worldId undefined for memories stored without one", async () => {
    const noWorldRoomId = v4() as UUID;
    await adapter.createRooms([
      {
        id: noWorldRoomId,
        agentId: testAgentId,
        name: "No-World Room",
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
    ]);
    const noWorldMemoryId = await adapter.createMemory(
      {
        id: v4() as UUID,
        entityId: testEntityId,
        agentId: testAgentId,
        roomId: noWorldRoomId,
        content: { text: "memory without a world" },
      } as Memory,
      "messages"
    );

    const memory = await adapter.getMemoryById(noWorldMemoryId);
    expect(memory).not.toBeNull();
    expect(memory?.worldId).toBeUndefined();
  });
});
