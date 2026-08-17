/**
 * Exercises the in-memory adapter's embedding-index lifecycle against the real
 * MemoryStorage and EphemeralHNSW index. Cleanup paths must keep stored memory
 * rows and indexed vectors synchronized so searches neither compare mixed
 * dimensions nor lose live results behind deleted candidates.
 */
import { randomUUID } from "node:crypto";
import type { Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

describe("clearEmbeddingsOutsideActiveDimension", () => {
  const agentId = randomUUID() as UUID;
  const entityId = randomUUID() as UUID;
  const roomId = randomUUID() as UUID;
  let adapter: InMemoryDatabaseAdapter;

  const vector = (dimension: number, axis = 0): number[] => {
    const embedding = Array.from({ length: dimension }, () => 0);
    embedding[axis] = 1;
    return embedding;
  };

  const memory = (embedding: number[], text: string): Memory => ({
    id: randomUUID() as UUID,
    agentId,
    entityId,
    roomId,
    content: { text },
    embedding,
  });

  beforeEach(async () => {
    const storage = new MemoryStorage();
    await storage.init();
    adapter = new InMemoryDatabaseAdapter(storage, agentId);
    await adapter.init();
  });

  it("strips old-width vectors and leaves the active-width index searchable", async () => {
    await adapter.ensureEmbeddingDimension(1536);
    const stale = memory(vector(1536), "old cloud embedding");
    const [staleId] = await adapter.createMemories([{ memory: stale, tableName: "memories" }]);

    await adapter.ensureEmbeddingDimension(384);
    expect(await adapter.clearEmbeddingsOutsideActiveDimension()).toEqual([staleId]);

    const reclaimed = await adapter.getMemoriesByIds([staleId]);
    expect(reclaimed[0]?.embedding).toBeUndefined();

    const fresh = memory(vector(384), "active local embedding");
    const [freshId] = await adapter.createMemories([{ memory: fresh, tableName: "memories" }]);

    const results = await adapter.searchMemories({
      tableName: "memories",
      embedding: vector(384),
      match_threshold: 0,
      limit: 10,
    });
    expect(results.map((result) => result.id)).toEqual([freshId]);
    expect(await adapter.clearEmbeddingsOutsideActiveDimension()).toEqual([]);
  });

  it("reclaims same-width vectors when the semantic-space fingerprint changes", async () => {
    await adapter.ensureEmbeddingDimension(384);
    const legacy = memory(vector(384), "legacy GTE vector");
    const [legacyId] = await adapter.createMemories([{ memory: legacy, tableName: "memories" }]);

    const migrated = await adapter.reconcileEmbeddingSpace("BAAI/bge-small-en-v1.5:384:mean:l2:v1");
    expect(migrated.changed).toBe(true);
    expect(migrated.previousFingerprint).toBeUndefined();
    expect(migrated.staleMemoryIds).toEqual([legacyId]);
    expect((await adapter.getMemoriesByIds([legacyId]))[0]?.embedding).toBeUndefined();

    const fresh = memory(vector(384), "canonical BGE vector");
    const [freshId] = await adapter.createMemories([{ memory: fresh, tableName: "memories" }]);
    expect(
      await adapter.reconcileEmbeddingSpace("BAAI/bge-small-en-v1.5:384:mean:l2:v1")
    ).toMatchObject({ changed: false, staleMemoryIds: [] });
    expect((await adapter.getMemoriesByIds([freshId]))[0]?.embedding).toHaveLength(384);

    const nextSpace = await adapter.reconcileEmbeddingSpace(
      "BAAI/bge-small-en-v1.5:384:mean:l2:v2"
    );
    expect(nextSpace.previousFingerprint).toBe("BAAI/bge-small-en-v1.5:384:mean:l2:v1");
    expect(nextSpace.staleMemoryIds).toEqual([freshId]);
  });

  it("invalidates a vector when its source text changes without a replacement", async () => {
    await adapter.ensureEmbeddingDimension(384);
    const original = memory(vector(384), "canonical source");
    const [memoryId] = await adapter.createMemories([{ memory: original, tableName: "memories" }]);

    await adapter.updateMemories([{ id: memoryId, content: { text: "updated canonical source" } }]);

    expect((await adapter.getMemoriesByIds([memoryId]))[0]?.embedding).toBeUndefined();
    expect(
      await adapter.searchMemories({
        tableName: "memories",
        embedding: vector(384),
        match_threshold: 0,
        limit: 10,
      })
    ).toEqual([]);
  });

  it("invalidates a vector on an embedding-less upsert with changed text", async () => {
    await adapter.ensureEmbeddingDimension(384);
    const original = memory(vector(384), "canonical source");
    const [memoryId] = await adapter.createMemories([{ memory: original, tableName: "memories" }]);
    const { embedding: _embedding, ...withoutEmbedding } = original;

    await adapter.upsertMemories([
      {
        memory: {
          ...withoutEmbedding,
          id: memoryId,
          content: { text: "upserted canonical source" },
        },
        tableName: "memories",
      },
    ]);

    expect((await adapter.getMemoriesByIds([memoryId]))[0]?.embedding).toBeUndefined();
    expect(
      await adapter.searchMemories({
        tableName: "memories",
        embedding: vector(384),
        match_threshold: 0,
        limit: 10,
      })
    ).toEqual([]);
  });
});

describe("room deletion embedding cleanup", () => {
  it("removes deleted-room vectors so they cannot crowd live memories out of search", async () => {
    const agentId = randomUUID() as UUID;
    const entityId = randomUUID() as UUID;
    const deletedRoomId = randomUUID() as UUID;
    const liveRoomId = randomUUID() as UUID;
    const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), agentId);
    await adapter.initialize();
    await adapter.ensureEmbeddingDimension(2);

    const deletedMemories = [
      memoryForRoom(deletedRoomId, [1, 0], "deleted nearest"),
      memoryForRoom(deletedRoomId, [0.999, 0.001], "deleted second nearest"),
    ];
    const liveMemory = memoryForRoom(liveRoomId, [0.8, 0.6], "live farther result");

    await adapter.createMemories(
      [...deletedMemories, liveMemory].map((memory) => ({ memory, tableName: "memories" }))
    );
    await adapter.deleteRooms([deletedRoomId]);

    const results = await adapter.searchMemories({
      tableName: "memories",
      embedding: [1, 0],
      match_threshold: 0,
      count: 1,
    });

    expect(results.map((result) => result.id)).toEqual([liveMemory.id]);

    function memoryForRoom(roomId: UUID, embedding: number[], text: string): Memory {
      return {
        id: randomUUID() as UUID,
        agentId,
        entityId,
        roomId,
        content: { text },
        embedding,
      };
    }
  });
});
