/** Real PGlite source-conditioned vector persistence, not a mocked adapter. */
import { randomUUID } from "node:crypto";
import { ChannelType, type IDatabaseAdapter, type UUID } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseAdapter } from "../index.node";

describe("SQL embedding source writes", () => {
  let agentId: UUID, entityId: UUID, roomId: UUID;
  let adapter: IDatabaseAdapter;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    const setup = await createTestRuntime({
      characterName: "EmbeddingSourceSQL",
      embeddingDimensions: 384,
    });
    cleanup = setup.cleanup;
    agentId = setup.runtime.agentId;
    // Reuse the migrated fixture store but exercise this checkout's source adapter.
    adapter = createDatabaseAdapter({ dataDir: setup.pgliteDir }, agentId);
    entityId = randomUUID() as UUID;
    roomId = randomUUID() as UUID;
    await setup.runtime.ensureConnection({
      entityId,
      roomId,
      worldId: agentId,
      source: "test",
      type: ChannelType.DM,
    });
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it("accepts current source, rejects stale/foreign/deleted source and preserves exact text", async () => {
    const id = randomUUID() as UUID;
    const memory = { id, agentId, entityId, roomId, content: { text: "Original  text\n" } };
    const oldVector = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
    const newVector = Array.from({ length: 384 }, (_, i) => (i === 1 ? 1 : 0));
    const expected = { agentId, entityId, roomId, text: memory.content.text };
    await adapter.ensureEmbeddingDimension(384);
    await adapter.createMemories([{ memory, tableName: "messages" }]);
    expect(await adapter.updateMemoryEmbedding({ id, expected, embedding: oldVector })).toBe(true);
    for (const field of ["agentId", "entityId", "roomId"] as const) {
      expect(
        await adapter.updateMemoryEmbedding({
          id,
          expected: { ...expected, [field]: randomUUID() as UUID },
          embedding: newVector,
        })
      ).toBe(false);
    }
    expect(
      await adapter.updateMemoryEmbedding({
        id,
        expected: { ...expected, text: "Original text" },
        embedding: newVector,
      })
    ).toBe(false);
    await expect(adapter.updateMemoryEmbedding({ id, expected, embedding: [] })).rejects.toThrow();
    await expect(
      adapter.updateMemoryEmbedding({ id, expected, embedding: Array(384).fill(Number.NaN) })
    ).rejects.toThrow();
    await adapter.updateMemories([
      { id, content: { text: "Correction: café 🧡\n" }, embedding: newVector },
    ]);
    expect(await adapter.updateMemoryEmbedding({ id, expected, embedding: oldVector })).toBe(false);
    const [row] = await adapter.getMemoriesByIds([id]);
    expect(row.content.text).toBe("Correction: café 🧡\n");
    const hits = await adapter.searchMemories({
      roomId,
      tableName: "messages",
      embedding: newVector,
      match_threshold: 0.99,
    });
    expect(hits.map((hit) => hit.id)).toEqual([id]);
    await adapter.deleteMemories([id]);
    expect(
      await adapter.updateMemoryEmbedding({
        id,
        expected: { ...expected, text: "Correction: café 🧡\n" },
        embedding: newVector,
      })
    ).toBe(false);
    expect(await adapter.getMemoriesByIds([id])).toEqual([]);
  });

  it("serializes simultaneous writes against one source and does not duplicate vector rows", async () => {
    const id = randomUUID() as UUID;
    await adapter.createMemories([
      {
        memory: { id, agentId, entityId, roomId, content: { text: "same source" } },
        tableName: "messages",
      },
    ]);
    const update = {
      id,
      expected: { agentId, entityId, roomId, text: "same source" },
      embedding: Array(384).fill(0.1),
    };
    expect(
      await Promise.all([
        adapter.updateMemoryEmbedding(update),
        adapter.updateMemoryEmbedding(update),
      ])
    ).toEqual([true, true]);
    const hits = await adapter.searchMemories({
      roomId,
      tableName: "messages",
      embedding: update.embedding,
      match_threshold: 0.99,
    });
    expect(hits.filter((hit) => hit.id === id)).toHaveLength(1);
  });
});
