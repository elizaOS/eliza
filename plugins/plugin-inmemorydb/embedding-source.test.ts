/** Source-conditioned vector writes must not undo edits or resurrect deletes. */
import { randomUUID } from "node:crypto";
import type { UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

describe("embedding source writes", () => {
  const agentId = randomUUID() as UUID,
    entityId = randomUUID() as UUID,
    roomId = randomUUID() as UUID;
  let adapter: InMemoryDatabaseAdapter;
  beforeEach(async () => {
    adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), agentId);
    await adapter.init();
  });
  afterEach(async () => {
    await adapter.close();
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
  it("serializes source updates with conditional writes on shared storage", async () => {
    const storage = new MemoryStorage();
    await storage.init();
    const other = new InMemoryDatabaseAdapter(storage, agentId);
    await other.init();
    const writer = new InMemoryDatabaseAdapter(storage, agentId);
    await writer.init();
    const id = randomUUID() as UUID;
    const memory = { id, agentId, entityId, roomId, content: { text: "original" } };
    try {
      await writer.createMemories([{ memory, tableName: "messages" }]);
      const expected = { agentId, entityId, roomId, text: "original" };
      const edit = other.updateMemories([{ id, content: { text: "corrected" } }]);
      const stale = writer.updateMemoryEmbedding({ id, expected, embedding: Array(384).fill(0.1) });
      await edit;
      expect(await stale).toBe(false);
      expect((await writer.getMemoriesByIds([id]))[0].content.text).toBe("corrected");
    } finally {
      await writer.close();
      await other.close();
    }
  });
});
