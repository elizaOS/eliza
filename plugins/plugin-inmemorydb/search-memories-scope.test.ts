/**
 * Regression coverage for `InMemoryDatabaseAdapter.searchMemories` scope
 * eligibility. Pins the "top K among eligible memories" contract shared with
 * the plugin-sql adapter (see `plugins/plugin-sql/src/base.ts` searchMemories,
 * which warns that a global vector top-K filtered afterwards "silently drops
 * eligible matches whenever closer out-of-scope vectors outnumber the
 * candidate pool"). Runs against a real `InMemoryDatabaseAdapter` +
 * `MemoryStorage` + `EphemeralHNSW`, no mocks. Every case seeds closer
 * out-of-scope vectors that would starve the in-scope result under the old
 * two-stage form.
 */
import { randomUUID } from "node:crypto";
import type { Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { EphemeralHNSW, type IVectorStorage, type VectorSearchResult } from "./index";
import { MemoryStorage } from "./storage-memory";

const DIM = 384;

/** Unit vector on the query axis: cosine similarity 1.0 with `onAxis()`. */
function onAxis(): number[] {
  const v = Array.from({ length: DIM }, () => 0);
  v[0] = 1;
  return v;
}

/**
 * Slightly off-axis unit vector: cosine similarity ~0.995 with `onAxis()`.
 * Distinct `tilt` values across seeds keep similarities strictly ordered so we
 * can assert descending-similarity ordering deterministically.
 */
function offAxis(tilt: number): number[] {
  const v = Array.from({ length: DIM }, () => 0);
  v[0] = 1;
  v[1] = tilt;
  const norm = Math.hypot(1, tilt);
  return v.map((x) => x / norm);
}

describe("searchMemories applies scope before the top-K cut", () => {
  const agentId = randomUUID() as UUID;
  const roomA = randomUUID() as UUID;
  const roomB = randomUUID() as UUID;
  const worldA = randomUUID() as UUID;
  const worldB = randomUUID() as UUID;
  const entityA = randomUUID() as UUID;
  const entityB = randomUUID() as UUID;

  let adapter: InMemoryDatabaseAdapter;

  beforeEach(async () => {
    const storage = new MemoryStorage();
    await storage.init();
    adapter = new InMemoryDatabaseAdapter(storage, agentId);
    await adapter.init();
  });

  const seed = (memories: Memory[]) =>
    adapter.createMemories(memories.map((memory) => ({ memory, tableName: "memories" })));

  it("returns the in-room top-K even when a larger off-room corpus holds closer vectors", async () => {
    // 20 exact-match (sim 1.0) vectors in roomB would fill any global top-K and
    // starve roomA under the two-stage anti-pattern.
    const crowd: Memory[] = Array.from({ length: 20 }, (_, i) => ({
      entityId: entityB,
      roomId: roomB,
      content: { text: `crowd ${i}` },
      embedding: onAxis(),
    }));
    // 5 slightly off-axis (sim ~0.995) vectors in roomA — the eligible set.
    const inRoom: Memory[] = Array.from({ length: 5 }, (_, i) => ({
      entityId: entityA,
      roomId: roomA,
      content: { text: `roomA ${i}` },
      embedding: offAxis(0.05 + i * 0.01),
    }));
    await seed([...crowd, ...inRoom]);

    const results = await adapter.searchMemories({
      tableName: "memories",
      embedding: onAxis(),
      match_threshold: 0,
      count: 3,
      roomId: roomA,
    });

    expect(results).toHaveLength(3);
    for (const memory of results) {
      expect(memory.roomId).toBe(roomA);
    }
    // Highest-similarity in-room memories first (smallest tilt = closest).
    const sims = results.map((m) => m.similarity ?? 0);
    expect(sims[0]).toBeGreaterThanOrEqual(sims[1] ?? 0);
    expect(sims[1]).toBeGreaterThanOrEqual(sims[2] ?? 0);
    expect(results[0]?.content.text).toBe("roomA 0");
  });

  it("honors worldId scope past a crowd of closer out-of-world vectors", async () => {
    const crowd: Memory[] = Array.from({ length: 15 }, (_, i) => ({
      entityId: entityB,
      roomId: roomB,
      worldId: worldB,
      content: { text: `world crowd ${i}` },
      embedding: onAxis(),
    }));
    const inWorld: Memory[] = Array.from({ length: 4 }, (_, i) => ({
      entityId: entityA,
      roomId: roomA,
      worldId: worldA,
      content: { text: `worldA ${i}` },
      embedding: offAxis(0.05 + i * 0.01),
    }));
    await seed([...crowd, ...inWorld]);

    const results = await adapter.searchMemories({
      tableName: "memories",
      embedding: onAxis(),
      match_threshold: 0,
      count: 4,
      worldId: worldA,
    });

    expect(results).toHaveLength(4);
    for (const memory of results) {
      expect(memory.worldId).toBe(worldA);
    }
  });

  it("honors entityId scope past a crowd of closer out-of-entity vectors", async () => {
    const crowd: Memory[] = Array.from({ length: 15 }, (_, i) => ({
      entityId: entityB,
      roomId: roomA,
      content: { text: `entity crowd ${i}` },
      embedding: onAxis(),
    }));
    const inEntity: Memory[] = Array.from({ length: 4 }, (_, i) => ({
      entityId: entityA,
      roomId: roomA,
      content: { text: `entityA ${i}` },
      embedding: offAxis(0.05 + i * 0.01),
    }));
    await seed([...crowd, ...inEntity]);

    const results = await adapter.searchMemories({
      tableName: "memories",
      embedding: onAxis(),
      match_threshold: 0,
      count: 4,
      entityId: entityA,
    });

    expect(results).toHaveLength(4);
    for (const memory of results) {
      expect(memory.entityId).toBe(entityA);
    }
  });

  it("honors the unique flag past a crowd of closer non-unique vectors", async () => {
    const crowd = Array.from({ length: 15 }, (_, i) => ({
      memory: {
        entityId: entityA,
        roomId: roomA,
        content: { text: `dup ${i}` },
        embedding: onAxis(),
      } as Memory,
      tableName: "memories",
      unique: false,
    }));
    const uniques = Array.from({ length: 3 }, (_, i) => ({
      memory: {
        entityId: entityA,
        roomId: roomA,
        content: { text: `unique ${i}` },
        embedding: offAxis(0.05 + i * 0.01),
      } as Memory,
      tableName: "memories",
      unique: true,
    }));
    await adapter.createMemories([...crowd, ...uniques]);

    const results = await adapter.searchMemories({
      tableName: "memories",
      embedding: onAxis(),
      match_threshold: 0,
      count: 3,
      unique: true,
    });

    expect(results).toHaveLength(3);
    for (const memory of results) {
      expect(memory.unique).toBe(true);
    }
  });

  it("returns all eligible in-scope matches when count exceeds the eligible pool", async () => {
    const crowd: Memory[] = Array.from({ length: 20 }, (_, i) => ({
      entityId: entityB,
      roomId: roomB,
      content: { text: `crowd ${i}` },
      embedding: onAxis(),
    }));
    const inRoom: Memory[] = Array.from({ length: 5 }, (_, i) => ({
      entityId: entityA,
      roomId: roomA,
      content: { text: `roomA ${i}` },
      embedding: offAxis(0.05 + i * 0.01),
    }));
    await seed([...crowd, ...inRoom]);

    const results = await adapter.searchMemories({
      tableName: "memories",
      embedding: onAxis(),
      match_threshold: 0,
      count: 50,
      roomId: roomA,
    });

    expect(results).toHaveLength(5);
    for (const memory of results) {
      expect(memory.roomId).toBe(roomA);
    }
  });

  it("is behavior-preserving for a single-room corpus with no cross-scope crowding", async () => {
    const inRoom: Memory[] = Array.from({ length: 6 }, (_, i) => ({
      entityId: entityA,
      roomId: roomA,
      content: { text: `only ${i}` },
      embedding: offAxis(0.02 + i * 0.01),
    }));
    await seed(inRoom);

    const results = await adapter.searchMemories({
      tableName: "memories",
      embedding: onAxis(),
      match_threshold: 0,
      count: 3,
      roomId: roomA,
    });

    expect(results).toHaveLength(3);
    // Closest tilt first, strictly descending similarity.
    expect(results.map((m) => m.content.text)).toEqual(["only 0", "only 1", "only 2"]);
    const sims = results.map((m) => m.similarity ?? 0);
    expect(sims[0]).toBeGreaterThan(sims[1] ?? 0);
    expect(sims[1]).toBeGreaterThan(sims[2] ?? 0);
  });

  it("returns the global top-K when no optional scope filter is supplied", async () => {
    const memories: Memory[] = Array.from({ length: 8 }, (_, i) => ({
      entityId: entityA,
      roomId: i % 2 === 0 ? roomA : roomB,
      content: { text: `global ${i}` },
      embedding: offAxis(0.01 + i * 0.01),
    }));
    await seed(memories);

    const results = await adapter.searchMemories({
      tableName: "memories",
      embedding: onAxis(),
      match_threshold: 0,
      count: 3,
    });

    expect(results.map((memory) => memory.content.text)).toEqual([
      "global 0",
      "global 1",
      "global 2",
    ]);
  });

  it("orders equal-distance results deterministically by memory id", async () => {
    const ids = [
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ] as UUID[];
    await seed(
      ids.map((id) => ({
        id,
        entityId: entityA,
        roomId: roomA,
        content: { text: id },
        embedding: onAxis(),
      }))
    );

    const results = await adapter.searchMemories({
      tableName: "memories",
      embedding: onAxis(),
      match_threshold: 0,
      count: 2,
    });

    expect(results.map((memory) => memory.id)).toEqual([ids[1], ids[2]]);
  });

  it("fails closed on a non-finite query and rejects a dimension mismatch", async () => {
    await seed([
      {
        entityId: entityA,
        roomId: roomA,
        content: { text: "valid" },
        embedding: onAxis(),
      },
    ]);

    const nonFinite = onAxis();
    nonFinite[0] = Number.NaN;
    await expect(
      adapter.searchMemories({
        tableName: "memories",
        embedding: nonFinite,
        match_threshold: 0,
      })
    ).resolves.toEqual([]);
    await expect(
      adapter.searchMemories({
        tableName: "memories",
        embedding: [1, 0],
        match_threshold: 0,
      })
    ).rejects.toThrow("Query dimension mismatch: expected 384, got 2");
  });
});

describe("EphemeralHNSW exact top-K boundaries", () => {
  it("preserves the public legacy vector-storage contract and size inspection", async () => {
    const legacyStorage: IVectorStorage = {
      async init(): Promise<void> {},
      async add(): Promise<void> {},
      async remove(): Promise<void> {},
      async search(): Promise<VectorSearchResult[]> {
        return [];
      },
      async clear(): Promise<void> {},
    };

    await expect(legacyStorage.search([1, 0, 0], 1)).resolves.toEqual([]);

    const index = new EphemeralHNSW();
    await index.init(3);
    expect(index.size()).toBe(0);
    await index.add("one", [1, 0, 0]);
    expect(index.size()).toBe(1);
    await index.remove("one");
    expect(index.size()).toBe(0);
  });

  it("keeps a bounded, ordered result for a larger corpus", async () => {
    const index = new EphemeralHNSW();
    await index.init(3);
    for (let i = 0; i < 512; i += 1) {
      const tilt = (i + 1) / 1_000;
      await index.add(String(i).padStart(4, "0"), [1, tilt, 0]);
    }

    const results = await index.searchExact([1, 0, 0], 7, 0);

    expect(results).toHaveLength(7);
    expect(results.map((result) => result.id)).toEqual([
      "0000",
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
    ]);
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i]?.distance).toBeGreaterThanOrEqual(results[i - 1]?.distance ?? 0);
    }
  });
});
