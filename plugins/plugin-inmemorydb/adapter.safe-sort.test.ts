/**
 * Newest-first ordering of the ephemeral adapter's non-paginated memory reads
 * when a stored row carries a non-finite `createdAt`.
 *
 * Drives the real `InMemoryDatabaseAdapter` over real `MemoryStorage`:
 * `getMemoriesByRoomIds` and `getMemoriesByWorldId` must keep their
 * `(createdAt DESC, id DESC)` contract instead of letting a `NaN` comparator
 * result leave neighbouring rows in an engine-defined order.
 */

import type { Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const agentId = "10000000-0000-4000-8000-000000000001" as UUID;
const entityId = "20000000-0000-4000-8000-000000000001" as UUID;
const roomId = "30000000-0000-4000-8000-000000000001" as UUID;
const worldId = "40000000-0000-4000-8000-000000000001" as UUID;

const EARLY = "a1000000-0000-4000-8000-000000000001" as UUID;
const BROKEN = "a2000000-0000-4000-8000-000000000002" as UUID;
const LATE = "a3000000-0000-4000-8000-000000000003" as UUID;

let adapter: InMemoryDatabaseAdapter;

function memory(id: UUID, createdAt: number, text: string): Memory {
  return {
    id,
    agentId,
    entityId,
    roomId,
    worldId,
    createdAt,
    content: { text },
  };
}

/**
 * Insertion order is the order `getWhere` hands back, and it is chosen so the
 * pre-fix comparator misorders the two finite rows: the `NaN` row sits between
 * them, every comparison against it yields `NaN`, and the engine leaves the
 * ascending run untouched instead of reversing it.
 */
async function seed(): Promise<void> {
  await adapter.createMemories([
    { memory: memory(EARLY, 100, "early"), tableName: "messages" },
    {
      memory: memory(BROKEN, Number.NaN as unknown as number, "broken"),
      tableName: "messages",
    },
    { memory: memory(LATE, 200, "late"), tableName: "messages" },
  ]);
}

beforeEach(async () => {
  const storage = new MemoryStorage();
  await storage.init();
  adapter = new InMemoryDatabaseAdapter(storage, agentId);
  await adapter.init();
});

describe("InMemoryDatabaseAdapter newest-first memory reads", () => {
  it("getMemoriesByRoomIds keeps finite rows newest-first around a NaN createdAt", async () => {
    await seed();
    const results = await adapter.getMemoriesByRoomIds({
      roomIds: [roomId],
      tableName: "messages",
    });
    expect(results.map((m) => m.id)).toEqual([LATE, EARLY, BROKEN]);
  });

  it("getMemoriesByWorldId keeps finite rows newest-first around a NaN createdAt", async () => {
    await seed();
    const results = await adapter.getMemoriesByWorldId({
      worldIds: [worldId],
      tableName: "messages",
    });
    expect(results.map((m) => m.id)).toEqual([LATE, EARLY, BROKEN]);
  });

  it("getMemoriesByRoomIds applies limit to the ordered result, not the raw insertion order", async () => {
    await seed();
    const results = await adapter.getMemoriesByRoomIds({
      roomIds: [roomId],
      tableName: "messages",
      limit: 1,
    });
    expect(results.map((m) => m.id)).toEqual([LATE]);
  });

  it("breaks equal timestamps by descending id in both reads", async () => {
    const lowId = "b1000000-0000-4000-8000-000000000001" as UUID;
    const highId = "b2000000-0000-4000-8000-000000000002" as UUID;
    await adapter.createMemories([
      { memory: memory(lowId, 500, "low"), tableName: "messages" },
      { memory: memory(highId, 500, "high"), tableName: "messages" },
    ]);
    const byRoom = await adapter.getMemoriesByRoomIds({
      roomIds: [roomId],
      tableName: "messages",
    });
    expect(byRoom.map((m) => m.id)).toEqual([highId, lowId]);
    const byWorld = await adapter.getMemoriesByWorldId({
      worldIds: [worldId],
      tableName: "messages",
    });
    expect(byWorld.map((m) => m.id)).toEqual([highId, lowId]);
  });
});
