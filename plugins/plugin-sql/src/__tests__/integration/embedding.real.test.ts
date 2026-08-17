/**
 * Verifies memories can be created with embeddings and read back with the vector
 * dimension preserved, including an adapter-scoped dimension change (384 to 768).
 * Runs against a real Postgres or PGlite backend via `createIsolatedTestDatabase`.
 */
import {
  type Agent,
  CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
  ChannelType,
  type Entity,
  type Memory,
  MemoryType,
  type Room,
  type UUID,
} from "@elizaos/core";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { cacheTable, embeddingTable, memoryTable } from "../../schema";
import { bgeSmallEnV15EmbeddingTable } from "../../schema/embedding";
import * as migrationSchema from "../../schema/index";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("Embedding Integration Tests", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testEntityId: UUID;
  let testRoomId: UUID;

  async function createLegacy384Memory(text: string, vector: number[]): Promise<UUID> {
    const memoryId = await adapter.createMemory(
      {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
        content: { text },
        createdAt: Date.now(),
        unique: false,
        metadata: { type: MemoryType.CUSTOM, source: "legacy-test" },
      },
      "embedding_test"
    );
    const db = adapter.getDatabase() as DrizzleDatabase;
    await db.insert(embeddingTable).values({
      id: uuidv4() as UUID,
      memoryId,
      dim384: vector,
    });
    return memoryId;
  }

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("embedding-tests");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    // Generate random UUIDs for test data
    testEntityId = uuidv4() as UUID;
    testRoomId = uuidv4() as UUID;

    await adapter.createEntities([
      {
        id: testEntityId,
        agentId: testAgentId,
        names: ["Test Entity"],
      } as Entity,
    ]);
    await adapter.createRooms([
      {
        id: testRoomId,
        agentId: testAgentId,
        name: "Test Room",
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
    ]);
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe("Embedding Tests", () => {
    beforeEach(async () => {
      await adapter.ensureEmbeddingDimension(384);
      const db = adapter.getDatabase() as DrizzleDatabase;
      await db.delete(bgeSmallEnV15EmbeddingTable);
      await db.delete(embeddingTable);
      await db.delete(memoryTable);
      await db.delete(cacheTable);
    });

    it("keeps the versioned BGE table outside legacy migration snapshots", () => {
      expect(migrationSchema).not.toHaveProperty("bgeSmallEnV15EmbeddingTable");
    });

    it("should create a memory with an embedding and retrieve it", async () => {
      await adapter.ensureEmbeddingDimension(384);
      const memory: Memory = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
        content: { text: "This memory has an embedding." },
        embedding: Array.from({ length: 384 }, () => Math.random()),
        createdAt: Date.now(),
        unique: false,
        metadata: {
          type: MemoryType.CUSTOM,
          source: "test",
        },
      };

      const memoryId = await adapter.createMemory(memory, "embedding_test");
      expect(memoryId).toBe(memory.id as UUID);

      const retrieved = await adapter.getMemoryById(memoryId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.embedding).toBeDefined();
      expect(retrieved?.embedding?.length).toBe(384);
    });

    it("should handle different embedding dimensions", async () => {
      // Test with 768 dimensions
      await adapter.ensureEmbeddingDimension(768);

      const memory768: Memory = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
        content: { text: "This memory has a 768-dimension embedding." },
        embedding: Array.from({ length: 768 }, () => Math.random()),
        createdAt: Date.now(),
        unique: false,
        metadata: {
          type: MemoryType.CUSTOM,
          source: "test",
        },
      };

      const memoryId = await adapter.createMemory(memory768, "embedding_test_768");
      const retrieved = await adapter.getMemoryById(memoryId);
      expect(retrieved?.embedding?.length).toBe(768);
    });

    it("clearEmbeddingsOutsideActiveDimension reclaims stale-dimension vectors and keeps active-dimension ones", async () => {
      // An agent that used cloud 1536-dim embeddings, then switched to on-device
      // gte-small (384-dim): the 1536 vector must be reclaimed (a 384-dim search
      // can never match it) while the memory row itself survives.
      await adapter.ensureEmbeddingDimension(1536);
      const otherAgentId = uuidv4() as UUID;
      await adapter.createAgent({
        id: otherAgentId,
        name: "Other embedding agent",
      } as Agent);

      const stale: Memory = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
        content: { text: "Embedded with the old cloud model." },
        embedding: Array.from({ length: 1536 }, () => Math.random()),
        createdAt: Date.now(),
        unique: false,
        metadata: { type: MemoryType.CUSTOM, source: "test" },
      };
      const staleId = await adapter.createMemory(stale, "embedding_test");
      const otherStale: Memory = {
        id: uuidv4() as UUID,
        agentId: otherAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
        content: { text: "Other agent still uses the old cloud model." },
        embedding: Array.from({ length: 1536 }, () => Math.random()),
        createdAt: Date.now(),
        unique: false,
        metadata: { type: MemoryType.CUSTOM, source: "test" },
      };
      const otherStaleId = await adapter.createMemory(otherStale, "embedding_test");

      await adapter.ensureEmbeddingDimension(384);
      const fresh: Memory = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
        content: { text: "Embedded with the new on-device model." },
        embedding: Array.from({ length: 384 }, () => Math.random()),
        createdAt: Date.now(),
        unique: false,
        metadata: { type: MemoryType.CUSTOM, source: "test" },
      };
      const freshId = await adapter.createMemory(fresh, "embedding_test");

      const reclaimed = await adapter.clearEmbeddingsOutsideActiveDimension();

      expect(reclaimed).toContain(staleId);
      expect(reclaimed).not.toContain(freshId);
      expect(reclaimed).not.toContain(otherStaleId);

      // The stale vector is gone but the memory row (its text) survives, so it
      // can be re-embedded at the active width.
      const staleRetrieved = await adapter.getMemoryById(staleId);
      expect(staleRetrieved).toBeDefined();
      expect(staleRetrieved?.embedding ?? undefined).toBeUndefined();

      // The active-dimension vector is untouched.
      const freshRetrieved = await adapter.getMemoryById(freshId);
      expect(freshRetrieved?.embedding?.length).toBe(384);

      // The cleanup is scoped to this adapter's agent; another agent may still
      // legitimately own old-width vectors until that agent boots and reclaims
      // against its own active dimension.
      await adapter.ensureEmbeddingDimension(1536);
      const otherRetrieved = await adapter.getMemoryById(otherStaleId);
      expect(otherRetrieved?.embedding?.length).toBe(1536);
      await adapter.ensureEmbeddingDimension(384);

      // Idempotent: nothing left to reclaim.
      expect(await adapter.clearEmbeddingsOutsideActiveDimension()).toEqual([]);
    });

    it("reconcileEmbeddingSpace discovers legacy same-width vectors without reading them as BGE", async () => {
      await adapter.ensureEmbeddingDimension(384);
      const canonicalVector = Array.from({ length: 384 }, () => Math.random());
      const legacyId = await createLegacy384Memory(
        "Legacy same-width GTE embedding.",
        canonicalVector
      );
      const fingerprint = CANONICAL_EMBEDDING_SPACE_FINGERPRINT;

      const migrated = await adapter.reconcileEmbeddingSpace(fingerprint);
      expect(migrated.changed).toBe(true);
      expect(migrated.staleMemoryIds).toEqual([legacyId]);
      expect((await adapter.getMemoryById(legacyId))?.embedding).toBeUndefined();

      // Complete the durable backfill that reconciliation requested before
      // asserting the next boot-equivalent discovery is empty.
      await adapter.updateMemory({ id: legacyId, embedding: canonicalVector });

      const fresh: Memory = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
        content: { text: "Canonical BGE embedding." },
        embedding: canonicalVector,
        createdAt: Date.now(),
        unique: false,
        metadata: { type: MemoryType.CUSTOM, source: "test" },
      };
      const freshId = await adapter.createMemory(fresh, "embedding_test");
      expect(await adapter.reconcileEmbeddingSpace(fingerprint)).toMatchObject({
        changed: false,
        staleMemoryIds: [],
      });
      expect((await adapter.getMemoryById(freshId))?.embedding).toHaveLength(384);
    });

    it("serializes concurrent fingerprint reconciliation and returns the same missing backlog", async () => {
      await adapter.ensureEmbeddingDimension(384);
      const legacyIds = await Promise.all(
        ["Legacy vector one.", "Legacy vector two."].map((text) =>
          createLegacy384Memory(
            text,
            Array.from({ length: 384 }, () => Math.random())
          )
        )
      );
      const fingerprint = CANONICAL_EMBEDDING_SPACE_FINGERPRINT;

      const results = await Promise.all([
        adapter.reconcileEmbeddingSpace(fingerprint),
        adapter.reconcileEmbeddingSpace(fingerprint),
      ]);

      expect(results.filter((result) => result.changed)).toHaveLength(1);
      for (const result of results) {
        expect([...result.staleMemoryIds].sort()).toEqual([...legacyIds].sort());
      }
      for (const id of legacyIds) {
        expect((await adapter.getMemoryById(id))?.embedding).toBeUndefined();
      }
    });

    it("survives legacy updates and whole-row cleanup by an older process", async () => {
      await adapter.ensureEmbeddingDimension(384);
      const legacyVector = [0, 1, ...Array.from({ length: 382 }, () => 0)];
      const canonicalVector = [1, ...Array.from({ length: 383 }, () => 0)];
      const lateLegacyVector = [0, 0, 1, ...Array.from({ length: 381 }, () => 0)];
      const memoryId = await createLegacy384Memory("Rolling deployment memory.", legacyVector);

      const reconciliation = await adapter.reconcileEmbeddingSpace(
        CANONICAL_EMBEDDING_SPACE_FINGERPRINT
      );
      expect(reconciliation.staleMemoryIds).toContain(memoryId);
      await adapter.updateMemory({ id: memoryId, embedding: canonicalVector });

      // Simulate a still-running old binary. It first updates dim_384, then
      // performs its historical active-dimension cleanup by deleting the whole
      // legacy row. Neither statement can name the separate canonical table.
      const db = adapter.getDatabase() as DrizzleDatabase;
      await db
        .update(embeddingTable)
        .set({ dim384: lateLegacyVector })
        .where(eq(embeddingTable.memoryId, memoryId));

      const beforeCleanup = await db
        .select({
          canonical: bgeSmallEnV15EmbeddingTable.dim384,
          legacy: embeddingTable.dim384,
        })
        .from(bgeSmallEnV15EmbeddingTable)
        .innerJoin(
          embeddingTable,
          eq(embeddingTable.memoryId, bgeSmallEnV15EmbeddingTable.memoryId)
        )
        .where(eq(bgeSmallEnV15EmbeddingTable.memoryId, memoryId));
      expect(beforeCleanup[0]?.canonical).toEqual(canonicalVector);
      expect(beforeCleanup[0]?.legacy).toEqual(lateLegacyVector);

      await db.delete(embeddingTable).where(eq(embeddingTable.memoryId, memoryId));

      const canonicalAfterCleanup = await db
        .select({ embedding: bgeSmallEnV15EmbeddingTable.dim384 })
        .from(bgeSmallEnV15EmbeddingTable)
        .where(eq(bgeSmallEnV15EmbeddingTable.memoryId, memoryId));
      expect(canonicalAfterCleanup[0]?.embedding).toEqual(canonicalVector);
      expect((await adapter.getMemoryById(memoryId))?.embedding).toEqual(canonicalVector);

      const matches = await adapter.searchMemoriesByEmbedding(canonicalVector, {
        tableName: "embedding_test",
        count: 1,
      });
      expect(matches[0]?.id).toBe(memoryId);
    });

    it("rediscovers unfinished canonical backfill on every boot-equivalent reconciliation", async () => {
      await adapter.ensureEmbeddingDimension(384);
      await adapter.reconcileEmbeddingSpace(CANONICAL_EMBEDDING_SPACE_FINGERPRINT);

      // An old process writes after the fingerprint transition. Pretend the
      // current process crashes after discovering this id but before backfill.
      const memoryId = await createLegacy384Memory(
        "Created by an old process after reconciliation.",
        [0, 1, ...Array.from({ length: 382 }, () => 0)]
      );
      const firstBoot = await adapter.reconcileEmbeddingSpace(
        CANONICAL_EMBEDDING_SPACE_FINGERPRINT
      );
      const afterCrash = await adapter.reconcileEmbeddingSpace(
        CANONICAL_EMBEDDING_SPACE_FINGERPRINT
      );

      expect(firstBoot).toMatchObject({ changed: false, staleMemoryIds: [memoryId] });
      expect(afterCrash).toMatchObject({ changed: false, staleMemoryIds: [memoryId] });

      await adapter.updateMemory({
        id: memoryId,
        embedding: [1, ...Array.from({ length: 383 }, () => 0)],
      });
      expect(
        await adapter.reconcileEmbeddingSpace(CANONICAL_EMBEDDING_SPACE_FINGERPRINT)
      ).toMatchObject({ changed: false, staleMemoryIds: [] });
    });

    it("invalidates a canonical vector when the current adapter changes its source text", async () => {
      await adapter.ensureEmbeddingDimension(384);
      const vectorA = [1, ...Array.from({ length: 383 }, () => 0)];
      const vectorB = [0, 1, ...Array.from({ length: 382 }, () => 0)];
      const memoryId = await adapter.createMemory(
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          entityId: testEntityId,
          roomId: testRoomId,
          content: { text: "Source text A" },
          embedding: vectorA,
          createdAt: Date.now(),
          unique: false,
          metadata: { type: MemoryType.CUSTOM, source: "source-binding-test" },
        },
        "embedding_test"
      );

      await adapter.updateMemory({ id: memoryId, content: { text: "Source text B" } });

      expect((await adapter.getMemoryById(memoryId))?.embedding).toBeUndefined();
      expect((await adapter.getMemoriesByIds([memoryId]))[0]?.embedding).toBeUndefined();
      expect(
        (
          await adapter.getMemories({
            agentId: testAgentId,
            tableName: "embedding_test",
            limit: 10,
          })
        ).find((memory) => memory.id === memoryId)?.embedding
      ).toBeUndefined();
      expect(
        await adapter.searchMemoriesByEmbedding(vectorA, {
          tableName: "embedding_test",
          count: 10,
        })
      ).toEqual([]);
      expect(
        await adapter.reconcileEmbeddingSpace(CANONICAL_EMBEDDING_SPACE_FINGERPRINT)
      ).toMatchObject({ staleMemoryIds: [memoryId] });

      await adapter.updateMemory({ id: memoryId, embedding: vectorB });
      expect((await adapter.getMemoryById(memoryId))?.embedding).toEqual(vectorB);
    });

    it("detects a legacy raw content update without cooperation from the old writer", async () => {
      await adapter.ensureEmbeddingDimension(384);
      const vectorA = [1, ...Array.from({ length: 383 }, () => 0)];
      const memoryId = await adapter.createMemory(
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          entityId: testEntityId,
          roomId: testRoomId,
          content: { text: "Text embedded before rolling upgrade" },
          embedding: vectorA,
          createdAt: Date.now(),
          unique: false,
          metadata: { type: MemoryType.CUSTOM, source: "legacy-content-writer" },
        },
        "embedding_test"
      );

      // A legacy binary only knows the memories table. Its raw write cannot
      // update source_text in the separate canonical table.
      const db = adapter.getDatabase() as DrizzleDatabase;
      await db
        .update(memoryTable)
        .set({ content: { text: "Text changed by legacy writer" } })
        .where(eq(memoryTable.id, memoryId));

      expect((await adapter.getMemoryById(memoryId))?.embedding).toBeUndefined();
      expect(
        await adapter.reconcileEmbeddingSpace(CANONICAL_EMBEDDING_SPACE_FINGERPRINT)
      ).toMatchObject({ staleMemoryIds: [memoryId] });
    });

    it("rejects null-stamped, missing-text, and blank-text canonical rows", async () => {
      await adapter.ensureEmbeddingDimension(384);
      const vector = [1, ...Array.from({ length: 383 }, () => 0)];
      const withoutTextId = await adapter.createMemory(
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          entityId: testEntityId,
          roomId: testRoomId,
          content: {},
          createdAt: Date.now(),
          unique: false,
          metadata: { type: MemoryType.CUSTOM, source: "null-source-test" },
        },
        "embedding_test"
      );
      const blankTextId = await adapter.createMemory(
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          entityId: testEntityId,
          roomId: testRoomId,
          content: { text: "   " },
          embedding: vector,
          createdAt: Date.now(),
          unique: false,
          metadata: { type: MemoryType.CUSTOM, source: "blank-source-test" },
        },
        "embedding_test"
      );
      const clearedBlankId = await adapter.createMemory(
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          entityId: testEntityId,
          roomId: testRoomId,
          content: { text: "Valid before blank update" },
          embedding: vector,
          createdAt: Date.now(),
          unique: false,
          metadata: { type: MemoryType.CUSTOM, source: "blank-clear-test" },
        },
        "embedding_test"
      );
      await adapter.updateMemory({
        id: clearedBlankId,
        content: { text: "   " },
        embedding: vector,
      });

      const db = adapter.getDatabase() as DrizzleDatabase;
      await db.insert(bgeSmallEnV15EmbeddingTable).values({
        id: uuidv4() as UUID,
        memoryId: withoutTextId,
        sourceText: null,
        dim384: vector,
      });
      // Simulate a malformed row written before blank-source rejection. The
      // equality guard must still refuse it even though both strings match.
      await db.insert(bgeSmallEnV15EmbeddingTable).values({
        id: uuidv4() as UUID,
        memoryId: blankTextId,
        sourceText: "   ",
        dim384: vector,
      });

      expect((await adapter.getMemoryById(withoutTextId))?.embedding).toBeUndefined();
      expect((await adapter.getMemoryById(blankTextId))?.embedding).toBeUndefined();
      expect((await adapter.getMemoryById(clearedBlankId))?.embedding).toBeUndefined();
      expect(
        await db
          .select({ id: bgeSmallEnV15EmbeddingTable.id })
          .from(bgeSmallEnV15EmbeddingTable)
          .where(eq(bgeSmallEnV15EmbeddingTable.memoryId, clearedBlankId))
      ).toEqual([]);
      expect(
        await adapter.reconcileEmbeddingSpace(CANONICAL_EMBEDDING_SPACE_FINGERPRINT)
      ).toMatchObject({
        staleMemoryIds: expect.arrayContaining([withoutTextId, blankTextId, clearedBlankId]),
      });
    });
  });
});
