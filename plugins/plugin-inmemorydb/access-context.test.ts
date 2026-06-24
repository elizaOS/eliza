import { randomUUID } from "node:crypto";
import type { AccessContext, Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

/**
 * PR 1 of permission-aware retrieval threads an optional `accessContext` through
 * the memory-read API but does not yet read it. These tests pin the guarantee
 * that passing one is accepted by the types and changes nothing at runtime.
 */
describe("accessContext is a no-op on memory retrieval (PR 1)", () => {
  const agentId = randomUUID() as UUID;
  const ownerEntity = randomUUID() as UUID;
  const userEntity = randomUUID() as UUID;
  const roomA = randomUUID() as UUID;
  const roomB = randomUUID() as UUID;
  const worldId = randomUUID() as UUID;

  let adapter: InMemoryDatabaseAdapter;

  const vector = (axis: number): number[] => {
    const embedding = Array.from({ length: 384 }, () => 0);
    embedding[axis] = 1;
    return embedding;
  };

  const sortById = (memories: Memory[]) =>
    [...memories].sort((a, b) => String(a.id).localeCompare(String(b.id)));

  beforeEach(async () => {
    const storage = new MemoryStorage();
    await storage.init();
    adapter = new InMemoryDatabaseAdapter(storage, agentId);
    await adapter.init();

    const seed: Memory[] = [
      {
        entityId: ownerEntity,
        roomId: roomA,
        worldId,
        content: { text: "owner in A" },
        embedding: vector(0),
      },
      {
        entityId: userEntity,
        roomId: roomA,
        worldId,
        content: { text: "user in A" },
        embedding: vector(1),
      },
      {
        entityId: userEntity,
        roomId: roomB,
        worldId,
        content: { text: "user in B" },
        embedding: vector(2),
      },
    ];
    await adapter.createMemories(seed.map((memory) => ({ memory, tableName: "memories" })));
  });

  const requesterCtx: AccessContext = {
    requesterEntityId: userEntity,
    worldId,
    role: "USER",
    isOwner: false,
  };

  it("getMemories returns identical rows with and without accessContext", async () => {
    const baseline = await adapter.getMemories({ tableName: "memories" });
    const scoped = await adapter.getMemories({
      tableName: "memories",
      accessContext: requesterCtx,
    });

    expect(baseline).toHaveLength(3);
    expect(sortById(scoped)).toEqual(sortById(baseline));
  });

  it("getMemoriesByRoomIds returns identical rows with and without accessContext", async () => {
    const baseline = await adapter.getMemoriesByRoomIds({
      tableName: "memories",
      roomIds: [roomA],
    });
    const scoped = await adapter.getMemoriesByRoomIds({
      tableName: "memories",
      roomIds: [roomA],
      accessContext: requesterCtx,
    });

    expect(baseline).toHaveLength(2);
    expect(sortById(scoped)).toEqual(sortById(baseline));
  });

  it("searchMemories returns identical rows with and without accessContext", async () => {
    const query = vector(0);
    const baseline = await adapter.searchMemories({
      tableName: "memories",
      embedding: query,
      match_threshold: 0,
      limit: 3,
    });
    const scoped = await adapter.searchMemories({
      tableName: "memories",
      embedding: query,
      match_threshold: 0,
      limit: 3,
      accessContext: requesterCtx,
    });

    expect(baseline).toHaveLength(3);
    expect(sortById(scoped)).toEqual(sortById(baseline));
  });
});
