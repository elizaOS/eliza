/**
 * Verifies memories can be created with embeddings and read back with the vector
 * dimension preserved, including an adapter-scoped dimension change (384 to 768).
 * Runs against a real Postgres or PGlite backend via `createIsolatedTestDatabase`.
 */
import {
  type Agent,
  ChannelType,
  type Entity,
  type Memory,
  MemoryType,
  type Room,
  type UUID,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { embeddingTable, memoryTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("Embedding Integration Tests", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testEntityId: UUID;
  let testRoomId: UUID;

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
      const db = adapter.getDatabase() as DrizzleDatabase;
      await db.delete(embeddingTable);
      await db.delete(memoryTable);
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
  });
});
