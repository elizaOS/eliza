/**
 * Exercises the in-memory adapter's embedding-width switch path against the
 * real MemoryStorage and EphemeralHNSW index. The cleanup must remove
 * old-width vectors before any active-width search or insert touches the HNSW
 * graph, otherwise cosine comparisons throw on mixed dimensions.
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
});
