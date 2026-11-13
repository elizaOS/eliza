/** Real runtime and PGlite proof that representation activation cannot relabel pending vectors. */
import { randomUUID } from "node:crypto";
import {
  ChannelType,
  getEmbeddingVectorSpace,
  identifyEmbeddingVector,
  type Memory,
  ModelType,
  type UUID,
} from "@elizaos/core";
import { expect, test } from "vitest";
import { MemoryStore } from "../../stores/memory.store";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

const vector = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));
const space = "test:embedding-provenance:384";

test("keeps pending embeddings bound to their original representation", async () => {
  const { adapter, runtime, cleanup, testAgentId } = await createIsolatedTestDatabase(
    "embedding-provenance",
    [],
    { postgresUrl: null }
  );
  const entityId = randomUUID() as UUID;
  const roomId = randomUUID() as UUID;
  const text =
    "Complete source 🦊 — retain the exact text through representation activation. ".repeat(200);
  const memory: Memory = {
    id: randomUUID() as UUID,
    agentId: testAgentId,
    entityId,
    roomId,
    content: { text },
    unique: true,
  };
  const originalContext = adapter.withEntityContext.bind(adapter);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let pendingInsert: Promise<UUID> | undefined;
  try {
    await adapter.createEntities([{ id: entityId, agentId: testAgentId, names: ["Owner"] }]);
    await adapter.createRooms([
      {
        id: roomId,
        agentId: testAgentId,
        name: "Provenance",
        source: "test",
        type: ChannelType.GROUP,
      },
    ]);
    await adapter.ensureEmbeddingDimension(384);
    await adapter.createMemory(memory, "messages");
    const legacyMemory = { ...memory, id: randomUUID() as UUID, embedding: [...vector] };
    await adapter.createMemory(legacyMemory, "messages");
    const cachedLegacy = (await adapter.getMemoryById(legacyMemory.id))?.embedding;
    const cachedLegacyBatch = (await adapter.getMemoriesByIds([legacyMemory.id]))[0]?.embedding;
    if (!cachedLegacy || !cachedLegacyBatch) throw new Error("Legacy vectors were not stored");
    runtime.registerModel(
      ModelType.TEXT_EMBEDDING,
      async () => Object.freeze([...vector]) as unknown as number[],
      "plain",
      1
    );
    runtime.registerModel(
      ModelType.TEXT_EMBEDDING_BATCH,
      async () => [Object.freeze([...vector]) as unknown as number[]],
      "plain",
      1
    );
    const oldVector = await runtime.useModel(ModelType.TEXT_EMBEDDING, { text }, "plain");
    const oldBatch = await runtime.useModel(
      ModelType.TEXT_EMBEDDING_BATCH,
      { texts: [text] },
      "plain"
    );
    expect(getEmbeddingVectorSpace(oldVector)).toBeUndefined();
    const oldBatchVector = oldBatch[0];
    if (!oldBatchVector) throw new Error("Embedding batch returned no vector");

    // A legacy caller is admitted before activation, then reaches its real
    // database transaction after the representation has changed.
    const delayedMemory = { ...memory, id: randomUUID() as UUID, embedding: [...vector] };
    adapter.withEntityContext = async (entity, callback) => {
      entered.resolve();
      await release.promise;
      return originalContext(entity, callback);
    };
    pendingInsert = adapter.createMemory(delayedMemory, "messages");
    const observedInsert = pendingInsert.then(
      (id) => ({ id, error: undefined }),
      (error: unknown) => ({ id: undefined, error })
    );
    await entered.promise;
    adapter.withEntityContext = originalContext;
    runtime.registerModel(
      ModelType.TEXT_EMBEDDING,
      async () => Object.freeze(identifyEmbeddingVector([...vector], space)) as unknown as number[],
      "named",
      100
    );
    const firstNamed = await runtime.useModel(ModelType.TEXT_EMBEDDING, { text }, "named");
    expect(getEmbeddingVectorSpace(firstNamed)).toBe(space);
    release.resolve();
    expect((await observedInsert).error).toMatchObject({ code: "EMBEDDING_SPACE_MISMATCH" });
    expect(await adapter.getMemoryById(delayedMemory.id)).toBeNull();
    expect(delayedMemory.content.text).toBe(text);

    const expected = { agentId: testAgentId, entityId, roomId, text };
    await expect(
      runtime.updateMemoryEmbedding({ id: memory.id as UUID, expected, embedding: oldVector })
    ).rejects.toMatchObject({ code: "EMBEDDING_SPACE_MISMATCH" });
    await expect(
      adapter.createMemories([
        {
          memory: { ...memory, id: randomUUID() as UUID, embedding: oldVector },
          tableName: "messages",
        },
      ])
    ).rejects.toMatchObject({ code: "EMBEDDING_SPACE_MISMATCH" });
    await expect(
      adapter.updateMemory({ id: memory.id as UUID, embedding: oldVector })
    ).rejects.toMatchObject({ code: "EMBEDDING_SPACE_MISMATCH" });
    const store = new MemoryStore({
      getDb: () => adapter.getDatabase() as DrizzleDatabase,
      withRetry: (operation) => operation(),
      withIsolationContext: (entity, callback) => adapter.withEntityContext(entity, callback),
      agentId: testAgentId,
      getEmbeddingDimension: () => "dim384",
      getEmbeddingSpace: () => space,
    });
    await expect(
      store.create({ ...memory, id: randomUUID() as UUID, embedding: oldVector }, "messages")
    ).rejects.toMatchObject({ code: "EMBEDDING_SPACE_MISMATCH" });
    await expect(
      store.update({ id: memory.id as UUID, embedding: oldVector })
    ).rejects.toMatchObject({ code: "EMBEDDING_SPACE_MISMATCH" });
    await expect(
      runtime.updateMemoryEmbedding({ id: memory.id as UUID, expected, embedding: oldBatchVector })
    ).rejects.toMatchObject({ code: "EMBEDDING_SPACE_MISMATCH" });
    expect((await adapter.getMemoryById(memory.id as UUID))?.content.text).toBe(text);
    expect((await adapter.getMemoryById(memory.id as UUID))?.embedding).toBeUndefined();
    expect((await adapter.getMemoryById(legacyMemory.id))?.content.text).toBe(text);
    expect((await adapter.getMemoryById(legacyMemory.id))?.embedding).toBeUndefined();
    for (const cached of [cachedLegacy, cachedLegacyBatch]) {
      await expect(
        adapter.updateMemoryEmbedding({ id: memory.id as UUID, expected, embedding: cached })
      ).rejects.toMatchObject({ code: "EMBEDDING_SPACE_MISMATCH" });
    }

    const current = await runtime.useModel(ModelType.TEXT_EMBEDDING, { text }, "named");
    expect(
      await runtime.updateMemoryEmbedding({ id: memory.id as UUID, expected, embedding: current })
    ).toBe(true);
    const unmarked = [...vector];
    await expect(
      adapter.updateMemoryEmbedding({
        id: memory.id as UUID,
        expected,
        embedding: unmarked,
      })
    ).rejects.toMatchObject({ code: "EMBEDDING_SPACE_MISMATCH" });
    await expect(
      adapter.searchMemories({ tableName: "messages", embedding: unmarked, count: 10 })
    ).rejects.toMatchObject({ code: "EMBEDDING_SPACE_MISMATCH" });
    expect((await adapter.getMemoryById(memory.id as UUID))?.embedding).toEqual(vector);
    expect(
      getEmbeddingVectorSpace((await adapter.getMemoryById(memory.id as UUID))?.embedding)
    ).toBe(space);
    expect((await adapter.getMemoryById(memory.id as UUID))?.content.text).toBe(text);
  } finally {
    adapter.withEntityContext = originalContext;
    release.resolve();
    await pendingInsert?.catch(() => {});
    await runtime.stop();
    await cleanup();
  }
}, 120_000);
