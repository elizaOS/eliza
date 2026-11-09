/** Near-duplicate memories store `unique: false`, like plugin-sql. */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Memory, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteDatabaseAdapter } from "./adapter";

const id = () => randomUUID() as UUID;
const agentId = id();
const roomId = id();
const entityId = id();
let directory: string;
const opened: SQLiteDatabaseAdapter[] = [];
async function open(file = "agent.sqlite", owner = agentId) {
  const adapter = SQLiteDatabaseAdapter.create(join(directory, file), owner);
  opened.push(adapter);
  await adapter.initialize();
  return adapter;
}
function memory(text: string, embedding = [1, 0, 0]): Memory & { id: UUID } {
  return {
    id: id(),
    agentId,
    entityId,
    roomId,
    content: { text },
    createdAt: Date.now(),
    embedding,
  };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "eliza-sqlite-uniqueness-"));
});
afterEach(async () => {
  for (const adapter of opened.splice(0)) await adapter.close();
  await rm(directory, { recursive: true, force: true });
});

describe("memory uniqueness", () => {
  it("marks a near-duplicate embedding as non-unique, like plugin-sql", async () => {
    const adapter = await open();
    await adapter.ensureEmbeddingDimension(3);
    const first = memory("first");
    const second = memory("second");
    await adapter.createMemories([{ memory: first, tableName: "messages" }]);
    await adapter.createMemories([{ memory: second, tableName: "messages" }]);

    const [storedFirst] = await adapter.getMemoriesByIds([first.id]);
    const [storedSecond] = await adapter.getMemoriesByIds([second.id]);
    expect(storedFirst?.unique).toBe(true);
    expect(storedSecond?.unique).toBe(false);

    const uniqueOnly = await adapter.getMemories({
      roomId,
      tableName: "messages",
      unique: true,
    });
    expect(uniqueOnly.map((row) => row.id)).toEqual([first.id]);
    expect(
      await adapter.countMemories({
        roomIds: [roomId],
        tableName: "messages",
        unique: true,
      }),
    ).toBe(1);
  });

  it("keeps an explicit unique flag on a near-duplicate", async () => {
    const adapter = await open();
    await adapter.ensureEmbeddingDimension(3);
    const first = memory("first");
    const second = memory("second");
    await adapter.createMemories([{ memory: first, tableName: "messages" }]);
    await adapter.createMemories([
      { memory: second, tableName: "messages", unique: true },
    ]);

    const [storedSecond] = await adapter.getMemoriesByIds([second.id]);
    expect(storedSecond?.unique).toBe(true);
  });

  it("keeps a near-duplicate in another room unique", async () => {
    const adapter = await open();
    await adapter.ensureEmbeddingDimension(3);
    const first = memory("first");
    const otherRoom = { ...memory("second"), roomId: id() };
    await adapter.createMemories([{ memory: first, tableName: "messages" }]);
    await adapter.createMemories([
      { memory: otherRoom, tableName: "messages" },
    ]);

    const [stored] = await adapter.getMemoriesByIds([otherRoom.id]);
    expect(stored?.unique).toBe(true);
  });

  it("keeps memories without an embedding unique", async () => {
    const adapter = await open();
    await adapter.ensureEmbeddingDimension(3);
    const first = { ...memory("first"), embedding: undefined };
    const second = { ...memory("second"), embedding: undefined };
    await adapter.createMemories([{ memory: first, tableName: "messages" }]);
    await adapter.createMemories([{ memory: second, tableName: "messages" }]);

    const [storedSecond] = await adapter.getMemoriesByIds([second.id]);
    expect(storedSecond?.unique).toBe(true);
  });

  it("keeps identical embeddings in one batch unique, like plugin-sql", async () => {
    const adapter = await open();
    await adapter.ensureEmbeddingDimension(3);
    const first = memory("first");
    const second = memory("second");
    await adapter.createMemories([
      { memory: first, tableName: "messages" },
      { memory: second, tableName: "messages" },
    ]);

    const [storedFirst, storedSecond] = await adapter.getMemoriesByIds([
      first.id,
      second.id,
    ]);
    expect(storedFirst?.unique).toBe(true);
    expect(storedSecond?.unique).toBe(true);
  });
});
