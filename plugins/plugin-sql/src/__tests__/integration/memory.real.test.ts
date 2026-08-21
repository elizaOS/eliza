/**
 * Integration tests for the memory CRUD/retrieval/search surface against a
 * real isolated PGlite/Postgres adapter: create/update/delete, partial and
 * nested-partial metadata updates, room/id-list/pagination reads, embedding
 * search, document+fragment cascade delete, and Memory<->MemoryModel field
 * mapping.
 */
import {
  ChannelType,
  type Content,
  type Entity,
  type Memory,
  type MemoryMetadata,
  MemoryType,
  type Room,
  type UUID,
  type World,
} from "@elizaos/core";
import { sql } from "drizzle-orm";
import { v4 } from "uuid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { embeddingTable, memoryTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";
import {
  documentMemoryId,
  memoryTestAgentId,
  memoryTestDocument,
  memoryTestFragments,
  memoryTestMemories,
  memoryTestMemoriesWithEmbedding,
} from "./seed";

const normalizeSignedZeroes = (embedding: number[] | null | undefined) =>
  embedding?.map((value) => (Object.is(value, -0) ? 0 : value));

describe("Memory Integration Tests", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let runtime: Awaited<ReturnType<typeof createIsolatedTestDatabase>>["runtime"];
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testRoomId: UUID;
  let testEntityId: UUID;
  let testWorldId: UUID;

  beforeAll(async () => {
    try {
      const setup = await createIsolatedTestDatabase("memory_tests");
      adapter = setup.adapter;
      runtime = setup.runtime;
      cleanup = setup.cleanup;
      testAgentId = setup.testAgentId;

      testRoomId = v4() as UUID;
      testEntityId = v4() as UUID;
      testWorldId = v4() as UUID;

      await adapter.createWorld({
        id: testWorldId,
        agentId: testAgentId,
        name: "Test World",
        serverId: "test-server",
      } as World);
      await adapter.createRooms([
        {
          id: testRoomId,
          agentId: testAgentId,
          worldId: testWorldId,
          name: "Test Room",
          source: "test",
          type: ChannelType.GROUP,
        } as Room,
      ]);
      await adapter.createEntities([
        {
          id: testEntityId,
          agentId: testAgentId,
          names: ["Test Entity"],
        } as Entity,
      ]);
      await adapter.addParticipant(testEntityId, testRoomId);
    } catch (error) {
      console.error("Failed to create test database for memory tests:", error);
      throw error;
    }
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  beforeEach(async () => {
    // Clean up memories and embeddings before each test
    const db = adapter.getDatabase() as DrizzleDatabase;
    // Delete embeddings first due to foreign key constraints
    await db.delete(embeddingTable);
    await db.delete(memoryTable);
  });

  const createTestMemory = (
    content: Content,
    embedding?: number[]
  ): Memory & { metadata: MemoryMetadata } => ({
    id: v4() as UUID,
    agentId: testAgentId,
    roomId: testRoomId,
    entityId: testEntityId,
    content,
    embedding,
    createdAt: Date.now(),
    unique: false,
    metadata: {
      type: MemoryType.CUSTOM,
      source: "test",
    },
  });

  it("should create and retrieve a memory with an embedding", async () => {
    const memory = createTestMemory(
      { text: "test" },
      Array.from({ length: 384 }, () => Math.random())
    );
    const memoryId = await adapter.createMemory(memory, "test");
    const retrieved = await adapter.getMemoryById(memoryId);
    expect(retrieved).toBeDefined();
    if (!retrieved) throw new Error("Memory should exist");
    if (!retrieved.embedding) throw new Error("Embedding should exist");
    expect(retrieved.embedding.length).toEqual(384);
  });

  it.each([0, 1, 2])(
    "rolls back every row when atomic batch position %i fails",
    async (failureIndex) => {
      const valid = [
        createTestMemory({ text: "parent" }),
        createTestMemory({ text: "fragment one" }),
        createTestMemory({ text: "fragment two" }),
      ];
      const batch = valid.map((memory, index) => ({
        memory: index === failureIndex ? { ...memory, id: "not-a-uuid" as UUID } : memory,
        tableName: index === 0 ? "documents" : "document_fragments",
        unique: false,
      }));

      await expect(adapter.createMemories(batch)).rejects.toThrow();

      for (const memory of valid) {
        expect(await adapter.getMemoryById(memory.id as UUID)).toBeNull();
      }
    }
  );

  it("rejects an invalid batch embedding before writing its parent", async () => {
    const parent = createTestMemory({ text: "must remain unpublished" });
    const fragment = createTestMemory({ text: "bad embedding" }, [1, 2, 3]);

    await expect(
      adapter.createMemories([
        { memory: parent, tableName: "documents", unique: false },
        { memory: fragment, tableName: "document_fragments", unique: false },
      ])
    ).rejects.toThrow(/Invalid embedding in atomic memory batch/);

    expect(await adapter.getMemoryById(parent.id as UUID)).toBeNull();
    expect(await adapter.getMemoryById(fragment.id as UUID)).toBeNull();
  });

  it("isolates a failing atomic batch from a concurrent successful batch", async () => {
    const committed = [
      createTestMemory({ text: "committed parent" }),
      createTestMemory({ text: "committed fragment" }),
    ];
    const rolledBack = [
      createTestMemory({ text: "rolled-back parent" }),
      { ...createTestMemory({ text: "invalid fragment" }), id: "not-a-uuid" as UUID },
    ];

    const outcomes = await Promise.allSettled([
      adapter.createMemories(
        committed.map((memory, index) => ({
          memory,
          tableName: index === 0 ? "documents" : "document_fragments",
          unique: false,
        }))
      ),
      adapter.createMemories(
        rolledBack.map((memory, index) => ({
          memory,
          tableName: index === 0 ? "documents" : "document_fragments",
          unique: false,
        }))
      ),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await adapter.getMemoryById(committed[0].id as UUID)).not.toBeNull();
    expect(await adapter.getMemoryById(committed[1].id as UUID)).not.toBeNull();
    expect(await adapter.getMemoryById(rolledBack[0].id as UUID)).toBeNull();
  });

  afterEach(async () => {
    // Clean up memories after each test to ensure isolation
    const db = adapter.getDatabase() as DrizzleDatabase;
    // Delete in correct order to avoid foreign key constraint violations
    await db.delete(embeddingTable);
    await db.delete(memoryTable);
  });

  describe("Memory CRUD Operations", () => {
    it("should create a simple memory without embedding", async () => {
      const memory = createTestMemory({ text: "simple memory" });
      const memoryId = await adapter.createMemory(memory, "memories");
      const retrieved = await adapter.getMemoryById(memoryId);
      expect(retrieved).toBeDefined();
      if (!retrieved) throw new Error("Memory should exist");
      expect(retrieved.content).toEqual({ text: "simple memory" });
    });

    it("creates a duplicate ID atomically under concurrent writes", async () => {
      const id = v4() as UUID;
      const first = { ...createTestMemory({ text: "first" }), id };
      const second = { ...createTestMemory({ text: "second" }), id };

      const ids = await Promise.all([
        adapter.createMemory(first, "messages"),
        adapter.createMemory(second, "messages"),
      ]);

      expect(ids).toEqual([id, id]);
      const rows = await adapter.getMemoriesByIds([id]);
      expect(rows).toHaveLength(1);
      expect(["first", "second"]).toContain(rows[0]?.content.text);
    });

    it("should count memories through the runtime object contract", async () => {
      await adapter.createMemory(createTestMemory({ text: "message one" }), "messages");
      await adapter.createMemory(createTestMemory({ text: "message two" }), "messages");

      const count = await runtime.countMemories({
        roomId: testRoomId,
        unique: false,
        tableName: "messages",
      });

      expect(count).toBe(2);
    });

    it("should default runtime countMemories to the messages table", async () => {
      await adapter.createMemory(createTestMemory({ text: "message one" }), "messages");
      await adapter.createMemory(createTestMemory({ text: "message two" }), "messages");

      const count = await runtime.countMemories({
        roomId: testRoomId,
        unique: false,
      } as never);

      expect(count).toBe(2);
    });

    it("should update an existing memory", async () => {
      const memory = createTestMemory({ text: "original" });
      const memoryId = await adapter.createMemory(memory, "memories");
      await adapter.updateMemory({
        id: memoryId,
        content: { text: "updated" },
      });
      const retrieved = await adapter.getMemoryById(memoryId);
      expect(retrieved).not.toBeNull();
      if (!retrieved) throw new Error("Memory should exist");
      expect(retrieved.content).toEqual({ text: "updated" });
    });

    it("should delete a memory", async () => {
      const memory = createTestMemory({ text: "to be deleted" });
      const memoryId = await adapter.createMemory(memory, "memories");
      let retrieved = await adapter.getMemoryById(memoryId);
      expect(retrieved).toBeDefined();
      await adapter.deleteMemory(memoryId);
      retrieved = await adapter.getMemoryById(memoryId);
      expect(retrieved).toBeNull();
    });

    it("should create a memory with embedding", async () => {
      const memory: Memory = {
        id: v4() as UUID,
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
        content: { text: "memory with embedding" },
        createdAt: Date.now(),
        embedding: Array.from({ length: 384 }, () => Math.random()),
      };
      const memoryId = await adapter.createMemory(memory, "memories");
      const createdMemory = await adapter.getMemoryById(memoryId);
      expect(createdMemory).not.toBeNull();
      if (!createdMemory) throw new Error("Memory should exist");
      expect(createdMemory.embedding).toBeDefined();
      if (!createdMemory.embedding) throw new Error("Embedding should exist");
      expect(createdMemory.embedding.length).toBe(384);
    });

    it("should perform partial updates without affecting other fields", async () => {
      const memory = {
        ...memoryTestMemoriesWithEmbedding[0],
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
        metadata: {
          type: "test-original",
          source: "integration-test",
          tags: ["original", "test"],
          timestamp: 1000,
        },
      };

      const memoryId = await adapter.createMemory(memory, "memories");

      const contentUpdate = {
        id: memoryId,
        content: {
          text: "This is updated content only",
          type: "text",
        },
      };

      await adapter.updateMemory(contentUpdate);

      const afterContentUpdate = await adapter.getMemoryById(memoryId);
      expect(afterContentUpdate).not.toBeNull();
      if (!afterContentUpdate) throw new Error("Memory should exist");
      const content = afterContentUpdate.content as Record<string, unknown>;
      expect(content.text).toBe("This is updated content only");
      expect(normalizeSignedZeroes(afterContentUpdate.embedding)).toEqual(
        normalizeSignedZeroes(memory.embedding as number[])
      );
      expect(afterContentUpdate.metadata).toEqual(memory.metadata);

      const metadataUpdate = {
        id: memoryId,
        metadata: {
          type: "test-original",
          source: "updated-source", // Only updating the source field
          tags: ["original", "test"],
          timestamp: 1000,
        },
      };

      await adapter.updateMemory(metadataUpdate);

      const afterMetadataUpdate = await adapter.getMemoryById(memoryId);
      expect(afterMetadataUpdate).not.toBeNull();
      if (!afterMetadataUpdate) throw new Error("Memory should exist");
      const contentAfter = afterMetadataUpdate.content as Record<string, unknown>;
      expect(contentAfter.text).toBe("This is updated content only");
      const metadataAfter = afterMetadataUpdate.metadata as Record<string, unknown>;
      if (!metadataAfter) throw new Error("Metadata should exist");
      expect(metadataAfter.type).toBe("test-original");
      expect(metadataAfter.source).toBe("updated-source");
      expect(metadataAfter.tags).toEqual(["original", "test"]);
      expect(metadataAfter.timestamp).toBe(1000);
    });

    it("should perform nested partial updates without overriding existing fields", async () => {
      const originalMemory = {
        ...memoryTestMemoriesWithEmbedding[0],
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
        content: {
          text: "Original content text",
          type: "text",
          additionalInfo: "This should be preserved",
        },
        metadata: {
          type: "test-original",
          source: "integration-test",
          tags: ["original", "test"],
          timestamp: 1000,
        },
      };

      const memoryId = await adapter.createMemory(originalMemory, "memories");

      // When updating content, we must include the full content object
      // since partial updates fully replace the content object
      const contentTextUpdate = {
        id: memoryId,
        content: {
          text: "Updated text only",
          type: "text",
          additionalInfo: "This should be preserved",
        },
      };

      await adapter.updateMemory(contentTextUpdate);

      const afterContentTextUpdate = await adapter.getMemoryById(memoryId);
      expect(afterContentTextUpdate).not.toBeNull();
      if (!afterContentTextUpdate) throw new Error("Memory should exist");
      const contentAfterText = afterContentTextUpdate.content as Record<string, unknown>;
      expect(contentAfterText.text).toBe("Updated text only");
      expect(contentAfterText.type).toBe("text");
      expect(contentAfterText.additionalInfo).toBe("This should be preserved");
      expect(afterContentTextUpdate.metadata).toEqual(originalMemory.metadata);

      // Update only source field in metadata, but must include all metadata fields
      // since partial updates fully replace the metadata object
      const sourceUpdate = {
        id: memoryId,
        metadata: {
          type: "test-original",
          source: "updated-source",
          tags: ["original", "test"],
          timestamp: 1000,
        },
      };

      await adapter.updateMemory(sourceUpdate);

      const afterSourceUpdate = await adapter.getMemoryById(memoryId);
      expect(afterSourceUpdate).not.toBeNull();
      if (!afterSourceUpdate || !afterContentTextUpdate) throw new Error("Memory should exist");
      expect(afterSourceUpdate.content).toEqual(afterContentTextUpdate.content as Content);
      const metadataAfterSource = afterSourceUpdate.metadata as Record<string, unknown>;
      if (!metadataAfterSource) throw new Error("Metadata should exist");
      expect(metadataAfterSource.type).toBe("test-original");
      expect(metadataAfterSource.source).toBe("updated-source");
      expect(metadataAfterSource.tags).toEqual(["original", "test"]);
      expect(metadataAfterSource.timestamp).toBe(1000);
    });
  });

  describe("Memory Retrieval Operations", () => {
    it("should retrieve memories by room ID", async () => {
      await adapter.createMemory(createTestMemory({ text: "mem1" }), "messages");
      await adapter.createMemory(createTestMemory({ text: "mem2" }), "messages");
      const memories = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "messages",
      });
      expect(memories.length).toBe(2);
    });

    it("should respect start/end filters when timestamp is 0", async () => {
      await adapter.createMemory(
        {
          ...createTestMemory({ text: "epoch-message" }),
          createdAt: 0,
        },
        "messages"
      );
      await adapter.createMemory(
        {
          ...createTestMemory({ text: "later-message" }),
          createdAt: 10,
        },
        "messages"
      );

      const epochOnly = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "messages",
        start: 0,
        end: 0,
      });

      expect(epochOnly).toHaveLength(1);
      expect(epochOnly[0].content.text).toBe("epoch-message");
      expect(epochOnly[0].createdAt).toBe(0);
    });

    it("should count memories in a room", async () => {
      await adapter.createMemory(createTestMemory({ text: "mem1" }), "memories");
      await adapter.createMemory(createTestMemory({ text: "mem2" }), "memories");
      const count = await adapter.countMemories(testRoomId, false, "memories");
      expect(count).toBe(2);
    });

    it("should require tableName on reads and default counts to the messages table", async () => {
      await adapter.createMemory(createTestMemory({ text: "message one" }), "messages");
      await adapter.createMemory(createTestMemory({ text: "message two" }), "messages");
      // Seed a different table to prove reads/counts are table-scoped.
      await adapter.createMemory(createTestMemory({ text: "fact one" }), "facts");

      // getMemories has NO default table: tableName is required by the
      // IDatabaseAdapter contract (packages/core/src/types/database.ts), and
      // omitting it (only possible by bypassing the types) is a loud error,
      // not a silent empty read.
      await expect(adapter.getMemories({ roomId: testRoomId } as never)).rejects.toThrow(
        /tableName/
      );

      const memories = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "messages",
      });
      expect(memories).toHaveLength(2);
      expect(memories.map((memory) => memory.content.text)).toEqual(
        expect.arrayContaining(["message one", "message two"])
      );

      // countMemories keeps its documented legacy default: an omitted
      // tableName counts the messages table only (the "facts" row is excluded).
      const count = await adapter.countMemories(testRoomId, false);
      expect(count).toBe(2);
    });

    it("should retrieve memories by ID list", async () => {
      const memoryIds: UUID[] = [];

      for (const memory of memoryTestMemories.slice(0, 2)) {
        const testMemory = {
          ...memory,
          agentId: testAgentId,
          entityId: testEntityId,
          roomId: testRoomId,
        };
        const memoryId = await adapter.createMemory(testMemory, "memories");
        memoryIds.push(memoryId);
      }

      const memories = await adapter.getMemoriesByIds(memoryIds, "memories");

      expect(memories).toHaveLength(2);
      expect(memories.map((m) => m.id)).toEqual(expect.arrayContaining(memoryIds));
    });

    it("should retrieve memories with pagination", async () => {
      for (const memory of memoryTestMemories) {
        const testMemory = {
          ...memory,
          agentId: testAgentId,
          entityId: testEntityId,
          roomId: testRoomId,
        };
        await adapter.createMemory(testMemory, "memories");
      }

      const firstPage = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "memories",
        count: 2,
      });

      expect(firstPage).toHaveLength(2);

      const secondPage = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "memories",
      });

      expect(secondPage.length).toBeGreaterThanOrEqual(memoryTestMemories.length);
    });

    it("should apply a LIMIT clause when only `limit` is passed (not `count`)", async () => {
      for (const content of ["lim1", "lim2", "lim3", "lim4", "lim5"]) {
        await adapter.createMemory(createTestMemory({ text: content }), "memories");
      }

      const limited = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "memories",
        limit: 2,
      });
      expect(limited).toHaveLength(2);

      // `limit` should compose with `offset` just like `count` does.
      const limitedWithOffset = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "memories",
        limit: 2,
        offset: 2,
      });
      expect(limitedWithOffset).toHaveLength(2);
      const firstIds = new Set(limited.map((m) => m.id));
      for (const memory of limitedWithOffset) {
        expect(firstIds.has(memory.id)).toBe(false);
      }
    });

    it("should retrieve memories with offset for pagination", async () => {
      const memoryContents = ["mem1", "mem2", "mem3", "mem4", "mem5"];
      for (const content of memoryContents) {
        await adapter.createMemory(createTestMemory({ text: content }), "memories");
      }

      const firstPage = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "memories",
        count: 2,
        offset: 0,
      });
      expect(firstPage).toHaveLength(2);

      const secondPage = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "memories",
        count: 2,
        offset: 2,
      });
      expect(secondPage).toHaveLength(2);

      const thirdPage = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "memories",
        count: 2,
        offset: 4,
      });
      expect(thirdPage).toHaveLength(1);

      const allIds = [...firstPage, ...secondPage, ...thirdPage].map((m) => m.id);
      const uniqueIds = new Set(allIds);
      expect(allIds.length).toBe(uniqueIds.size);
    });

    it("should page by an exclusive createdAt/id cursor across earlier mutations", async () => {
      const createdAt = 1_750_000_000_000;
      const ids = [
        "00000000-0000-4000-8000-0000000000a1",
        "00000000-0000-4000-8000-0000000000a2",
        "00000000-0000-4000-8000-0000000000a3",
        "00000000-0000-4000-8000-0000000000a4",
        "00000000-0000-4000-8000-0000000000a5",
      ] as UUID[];
      for (const [index, id] of ids.entries()) {
        await adapter.createMemory(
          { ...createTestMemory({ text: `cursor ${index}` }), id, createdAt },
          "memories"
        );
      }

      const first = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "memories",
        limit: 2,
      });
      expect(first.map((memory) => memory.id)).toEqual([ids[4], ids[3]]);

      await adapter.deleteMemories([ids[4]]);
      await adapter.createMemory(
        {
          ...createTestMemory({ text: "inserted ahead" }),
          id: "00000000-0000-4000-8000-0000000000ff" as UUID,
          createdAt: createdAt + 1,
        },
        "memories"
      );
      const second = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "memories",
        limit: 2,
        cursor: { createdAt, id: ids[3] },
      });
      expect(second.map((memory) => memory.id)).toEqual([ids[2], ids[1]]);

      await expect(
        adapter.getMemories({
          roomId: testRoomId,
          tableName: "memories",
          offset: 0,
          cursor: { createdAt, id: ids[3] },
        })
      ).rejects.toThrow("cursor and offset are mutually exclusive");
    });

    it("does not skip rows whose database timestamps differ below cursor precision", async () => {
      const ids = [
        "00000000-0000-4000-8000-0000000000b1",
        "00000000-0000-4000-8000-0000000000b2",
        "00000000-0000-4000-8000-0000000000b3",
        "00000000-0000-4000-8000-0000000000b4",
      ] as UUID[];
      const db = adapter.getDatabase() as DrizzleDatabase;
      for (const [index, id] of ids.entries()) {
        const micros = 400 - index * 100;
        await db.execute(sql`
          INSERT INTO ${memoryTable}
            (id, type, created_at, content, entity_id, agent_id, room_id, world_id, "unique", metadata)
          VALUES
            (
              ${id}::uuid,
              'memories',
              ('2025-01-01T00:00:00.123000Z'::timestamptz + ${micros} * interval '1 microsecond'),
              ${JSON.stringify({ text: `sub-millisecond ${index}` })}::jsonb,
              ${testEntityId}::uuid,
              ${testAgentId}::uuid,
              ${testRoomId}::uuid,
              ${testWorldId}::uuid,
              false,
              '{}'::jsonb
            )
        `);
      }

      const first = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "memories",
        limit: 2,
      });
      expect(first.map((memory) => memory.id)).toEqual([ids[3], ids[2]]);
      expect(new Set(first.map((memory) => memory.createdAt))).toHaveLength(1);

      const second = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "memories",
        limit: 2,
        cursor: { createdAt: first[1].createdAt as number, id: ids[2] },
      });
      expect(second.map((memory) => memory.id)).toEqual([ids[1], ids[0]]);
    });

    it("should handle offset without count parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.createMemory(createTestMemory({ text: `mem${i}` }), "memories");
      }

      const allMemories = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "memories",
      });
      expect(allMemories.length).toBe(5);

      const withOffset = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "memories",
        offset: 2,
      });
      expect(withOffset.length).toBe(3);

      const lastThreeIds = allMemories.slice(2).map((m) => m.id);
      const offsetIds = withOffset.map((m) => m.id);
      expect(offsetIds).toEqual(lastThreeIds);
    });

    it("should handle edge cases for offset pagination", async () => {
      for (let i = 0; i < 3; i++) {
        await adapter.createMemory(createTestMemory({ text: `mem${i}` }), "memories");
      }

      const beyondOffset = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "memories",
        count: 2,
        offset: 10,
      });
      expect(beyondOffset.length).toBe(0);

      // Offset of 0 should behave like no offset
      const zeroOffset = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "memories",
        count: 2,
        offset: 0,
      });
      expect(zeroOffset.length).toBe(2);

      // No offset should return all (up to count limit)
      const noOffset = await adapter.getMemories({
        roomId: testRoomId,
        tableName: "memories",
        count: 2,
      });
      expect(noOffset.length).toBe(2);
      expect(noOffset.map((m) => m.id)).toEqual(zeroOffset.map((m) => m.id));
    });

    it("should reject negative offset values", async () => {
      await adapter.createMemory(createTestMemory({ text: "test" }), "memories");

      await expect(
        adapter.getMemories({
          roomId: testRoomId,
          tableName: "memories",
          offset: -1,
        })
      ).rejects.toThrow("offset must be a non-negative number");

      await expect(
        adapter.getMemories({
          roomId: testRoomId,
          tableName: "memories",
          count: 5,
          offset: -10,
        })
      ).rejects.toThrow("offset must be a non-negative number");
    });

    it("should maintain consistent pagination results with countMemories", async () => {
      const totalMemories = 10;
      for (let i = 0; i < totalMemories; i++) {
        await adapter.createMemory(createTestMemory({ text: `mem${i}` }), "memories");
      }

      const totalCount = await adapter.countMemories(testRoomId, false, "memories");
      expect(totalCount).toBe(totalMemories);

      const pageSize = 3;
      const totalPages = Math.ceil(totalCount / pageSize);
      const allPaginatedMemories: Memory[] = [];

      for (let page = 0; page < totalPages; page++) {
        const pageMemories = await adapter.getMemories({
          roomId: testRoomId,
          tableName: "memories",
          count: pageSize,
          offset: page * pageSize,
        });
        allPaginatedMemories.push(...pageMemories);
      }

      expect(allPaginatedMemories.length).toBe(totalMemories);

      const ids = allPaginatedMemories.map((m) => m.id);
      const uniqueIds = new Set(ids);
      expect(ids.length).toBe(uniqueIds.size);
    });
  });

  describe("Memory Search Operations", () => {
    it("should search memories by embedding similarity", async () => {
      const baseEmbedding = Array.from({ length: 384 }, () => Math.random());
      const memory1: Partial<Memory> = {
        id: v4() as UUID,
        content: { text: "memory 1" },
        createdAt: Date.now(),
        embedding: baseEmbedding,
      };
      memory1.agentId = testAgentId;
      memory1.roomId = testRoomId;
      memory1.entityId = testEntityId;
      await adapter.createMemory(memory1 as Memory, "search");

      const results = await adapter.searchMemoriesByEmbedding(baseEmbedding, {
        tableName: "search",
        roomId: testRoomId,
        count: 1,
      });

      expect(results.length).toBe(1);
      expect(results[0].id).toBe(memory1.id as UUID);
      expect(results[0].similarity).toBeGreaterThan(0.99);
    });

    it("creates the HNSW cosine index for the active dimension on ensure", async () => {
      await adapter.ensureEmbeddingDimension(384);
      const rows = await (
        adapter as unknown as { db: { execute: (q: unknown) => Promise<{ rows?: unknown[] }> } }
      ).db.execute(
        sql`SELECT indexname FROM pg_indexes WHERE tablename = 'embeddings' AND indexname = 'idx_embeddings_dim_384_hnsw_cosine'`
      );
      const names = (rows.rows ?? rows) as Array<{ indexname: string }>;
      expect(names.length).toBe(1);
    });

    it("short-circuits via IF NOT EXISTS when a valid index already exists (no rebuild)", async () => {
      const db = (
        adapter as unknown as {
          db: { execute: (q: unknown) => Promise<{ rows?: unknown[] }> };
        }
      ).db;
      const oidQuery = sql`SELECT i.indexrelid::bigint AS oid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'idx_embeddings_dim_384_hnsw_cosine'`;

      await adapter.ensureEmbeddingDimension(384);
      const first = await db.execute(oidQuery);
      const firstOid = ((first.rows ?? first) as Array<{ oid: unknown }>)[0]?.oid;
      expect(firstOid).toBeDefined();

      await adapter.ensureEmbeddingDimension(384);
      const second = await db.execute(oidQuery);
      const secondOid = ((second.rows ?? second) as Array<{ oid: unknown }>)[0]?.oid;
      // Same relation OID: the second ensure hit IF NOT EXISTS and did not
      // drop/recreate the index.
      expect(String(secondOid)).toBe(String(firstOid));
    });

    it("drops and rebuilds an INVALID index left by a failed concurrent build", async () => {
      const db = (
        adapter as unknown as {
          db: { execute: (q: unknown) => Promise<{ rows?: unknown[] }> };
        }
      ).db;
      await adapter.ensureEmbeddingDimension(384);
      const oidQuery = sql`SELECT i.indexrelid::bigint AS oid, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'idx_embeddings_dim_384_hnsw_cosine'`;
      const before = await db.execute(oidQuery);
      const beforeRow = ((before.rows ?? before) as Array<{ oid: unknown }>)[0];
      expect(beforeRow).toBeDefined();

      // Simulate the aftermath of a crashed CREATE INDEX CONCURRENTLY: the
      // catalog row exists but indisvalid = false (superuser catalog update —
      // the same state a failed concurrent build leaves behind).
      await db.execute(
        sql`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_embeddings_dim_384_hnsw_cosine'::regclass`
      );

      await adapter.ensureEmbeddingDimension(384);
      const after = await db.execute(oidQuery);
      const afterRows = (after.rows ?? after) as Array<{ oid: unknown; indisvalid: boolean }>;
      expect(afterRows.length).toBe(1);
      expect(afterRows[0].indisvalid).toBe(true);
      // A different relation OID proves the invalid index was dropped and
      // rebuilt, not just left in place behind IF NOT EXISTS.
      expect(String(afterRows[0].oid)).not.toBe(String(beforeRow.oid));
    });

    it("degrades without throwing when the index cannot be created", async () => {
      const db = (
        adapter as unknown as {
          db: { execute: (q: unknown) => Promise<{ rows?: unknown[] }> };
        }
      ).db;
      // Make CREATE INDEX fail for real by hiding the embeddings table; the
      // ensure path must warn and resolve (search degrades to a sequential
      // scan) rather than fail closed over a missing optimization.
      await db.execute(sql`ALTER TABLE "embeddings" RENAME TO "embeddings_hidden"`);
      try {
        await expect(adapter.ensureEmbeddingDimension(768)).resolves.toBeUndefined();
        const rows = await db.execute(
          sql`SELECT indexname FROM pg_indexes WHERE indexname = 'idx_embeddings_dim_768_hnsw_cosine'`
        );
        expect(((rows.rows ?? rows) as unknown[]).length).toBe(0);
      } finally {
        await db.execute(sql`ALTER TABLE "embeddings_hidden" RENAME TO "embeddings"`);
        await adapter.ensureEmbeddingDimension(384);
      }
    });

    it("ranks by similarity, honors the threshold, and filters through the KNN pool", async () => {
      // Orthogonal-ish vectors with known cosine ordering against the query.
      const dims = 384;
      const query = Array.from({ length: dims }, (_, i) => (i === 0 ? 1 : 0));
      const near = Array.from({ length: dims }, (_, i) => (i === 0 ? 1 : i === 1 ? 0.1 : 0));
      const far = Array.from({ length: dims }, (_, i) => (i === 1 ? 1 : 0));
      const nearId = v4() as UUID;
      const farId = v4() as UUID;
      for (const [id, embedding, text] of [
        [nearId, near, "near"],
        [farId, far, "far"],
      ] as const) {
        await adapter.createMemory(
          {
            id,
            content: { text },
            createdAt: Date.now(),
            embedding: [...embedding],
            agentId: testAgentId,
            roomId: testRoomId,
            entityId: testEntityId,
          } as Memory,
          "knn-order"
        );
      }

      const ranked = await adapter.searchMemoriesByEmbedding(query, {
        tableName: "knn-order",
        count: 10,
      });
      expect(ranked[0]?.id).toBe(nearId);
      expect(ranked[0]?.similarity ?? 0).toBeGreaterThan(ranked[1]?.similarity ?? 1);

      // The orthogonal vector (similarity 0) must fall to the threshold.
      const thresholded = await adapter.searchMemoriesByEmbedding(query, {
        tableName: "knn-order",
        count: 10,
        match_threshold: 0.5,
      });
      expect(thresholded.map((m) => m.id)).toEqual([nearId]);

      // Type filtering is part of the ordered scan itself.
      const otherTable = await adapter.searchMemoriesByEmbedding(query, {
        tableName: "some-other-table",
        count: 10,
      });
      expect(otherTable.length).toBe(0);
    });

    // Eligibility must be part of the KNN scan, not applied to a global
    // top-K sample: a filtered search is "top K among eligible memories",
    // and any two-stage global-candidate form silently starves a scope
    // whenever closer out-of-scope vectors outnumber the candidate pool.
    // Each case plants MORE nearer out-of-scope vectors (300) than the old
    // candidate-pool floor (256) so the starvation regression cannot pass.
    describe("filtered search under out-of-scope crowding", () => {
      const dims = 384;
      const query = Array.from({ length: dims }, (_, i) => (i === 0 ? 1 : 0));
      // cosine ~= 0.707 to the query — clearly eligible, never the global nearest.
      const target = Array.from({ length: dims }, (_, i) =>
        i === 0 || i === 1 ? Math.SQRT1_2 : 0
      );
      const DISTRACTORS = 300;

      const plantDistractors = async (
        overrides: Partial<Memory>,
        tableName: string
      ): Promise<void> => {
        for (let i = 0; i < DISTRACTORS; i++) {
          await adapter.createMemory(
            {
              id: v4() as UUID,
              content: { text: `distractor ${i}` },
              createdAt: Date.now(),
              // Exact query vector: cosine 1.0, always nearer than the target.
              embedding: [...query],
              agentId: testAgentId,
              roomId: testRoomId,
              entityId: testEntityId,
              unique: false,
              ...overrides,
            } as Memory,
            tableName
          );
        }
      };

      it("finds the eligible memory when 300 nearer vectors live in another table", async () => {
        const targetId = v4() as UUID;
        await adapter.createMemory(
          {
            id: targetId,
            content: { text: "the one eligible memory" },
            createdAt: Date.now(),
            embedding: [...target],
            agentId: testAgentId,
            roomId: testRoomId,
            entityId: testEntityId,
            unique: false,
          } as Memory,
          "starve-target-type"
        );
        await plantDistractors({}, "starve-distractor-type");

        const results = await adapter.searchMemoriesByEmbedding(query, {
          tableName: "starve-target-type",
          count: 1,
        });
        expect(results.map((m) => m.id)).toEqual([targetId]);
        expect(results[0]?.similarity ?? 0).toBeGreaterThan(0.7);
      });

      it("finds the eligible memory when 300 nearer vectors live in another room", async () => {
        const otherRoomId = v4() as UUID;
        await adapter.createRooms([
          {
            id: otherRoomId,
            agentId: testAgentId,
            source: "test",
            type: ChannelType.GROUP,
          } as Parameters<typeof adapter.createRooms>[0][0],
        ]);
        const targetId = v4() as UUID;
        await adapter.createMemory(
          {
            id: targetId,
            content: { text: "eligible in this room" },
            createdAt: Date.now(),
            embedding: [...target],
            agentId: testAgentId,
            roomId: testRoomId,
            entityId: testEntityId,
            unique: false,
          } as Memory,
          "starve-room-scope"
        );
        await plantDistractors({ roomId: otherRoomId }, "starve-room-scope");

        const results = await adapter.searchMemoriesByEmbedding(query, {
          tableName: "starve-room-scope",
          roomId: testRoomId,
          count: 1,
        });
        expect(results.map((m) => m.id)).toEqual([targetId]);
      });

      it("finds the eligible memory when 300 nearer vectors belong to another agent", async () => {
        const otherAgentId = v4() as UUID;
        await adapter.createAgent({
          id: otherAgentId,
          name: `crowding-agent-${otherAgentId.slice(0, 8)}`,
          bio: "starvation-test agent",
        } as Parameters<typeof adapter.createAgent>[0]);
        const targetId = v4() as UUID;
        await adapter.createMemory(
          {
            id: targetId,
            content: { text: "eligible for this agent" },
            createdAt: Date.now(),
            embedding: [...target],
            agentId: testAgentId,
            roomId: testRoomId,
            entityId: testEntityId,
            unique: false,
          } as Memory,
          "starve-agent-scope"
        );
        await plantDistractors({ agentId: otherAgentId }, "starve-agent-scope");

        const results = await adapter.searchMemoriesByEmbedding(query, {
          tableName: "starve-agent-scope",
          count: 1,
        });
        expect(results.map((m) => m.id)).toEqual([targetId]);
      });
    });
  });

  describe("Document and Fragment Operations", () => {
    it("should create a document with fragments", async () => {
      const testDocument = {
        ...memoryTestDocument,
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
      };
      await adapter.createMemory(testDocument, "documents");

      for (const fragment of memoryTestFragments) {
        const testFragment = {
          ...fragment,
          agentId: testAgentId,
          entityId: testEntityId,
          roomId: testRoomId,
        };
        await adapter.createMemory(testFragment, "fragments");
      }

      const fragments = await adapter.getMemories({
        tableName: "fragments",
        roomId: testRoomId,
      });

      expect(fragments.length).toEqual(memoryTestFragments.length);
    });

    it("should delete a document and its fragments", async () => {
      const testDocument = {
        ...memoryTestDocument,
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
      };
      await adapter.createMemory(testDocument, "documents");

      for (const fragment of memoryTestFragments) {
        const testFragment = {
          ...fragment,
          agentId: testAgentId,
          entityId: testEntityId,
          roomId: testRoomId,
        };
        await adapter.createMemory(testFragment, "fragments");
      }

      // Deleting the document must cascade to its fragments.
      await adapter.deleteMemory(documentMemoryId);

      const document = await adapter.getMemoryById(documentMemoryId);
      expect(document).toBeNull();

      const fragments = await adapter.getMemories({
        tableName: "fragments",
        roomId: testRoomId,
      });

      expect(fragments.length).toBe(0);
    });
  });

  describe("Memory Model Mapping", () => {
    it("should correctly map between Memory and MemoryModel", async () => {
      const testMemory = {
        ...memoryTestMemories[0],
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
      };

      await adapter.createMemory(testMemory, "memories");

      const retrievedMemory = await adapter.getMemoryById(testMemory.id as UUID);
      expect(retrievedMemory).not.toBeNull();
      if (!retrievedMemory) throw new Error("Memory should exist");

      expect(retrievedMemory.id).toBe(testMemory.id as UUID);
      expect(retrievedMemory.entityId).toBe(testMemory.entityId);
      expect(retrievedMemory.roomId).toBe(testMemory.roomId);
      expect(retrievedMemory.agentId).toBe(testMemory.agentId);
      const content = retrievedMemory.content as Record<string, unknown>;
      expect(content.text).toBe(testMemory.content.text as string);
      const metadata = retrievedMemory.metadata as Record<string, unknown>;
      if (testMemory.metadata && metadata) {
        expect(metadata.type).toBe(testMemory.metadata.type as string);
      }
    });

    it("should handle partial Memory objects in mapToMemoryModel", async () => {
      const uniqueEntityId = v4() as UUID;

      await adapter.createEntities([
        {
          id: uniqueEntityId,
          agentId: testAgentId,
          names: ["Test Entity"],
        } as Entity,
      ]);

      const partialMemory: Partial<Memory> = {
        id: memoryTestAgentId,
        entityId: uniqueEntityId,
        roomId: testRoomId,
        agentId: testAgentId,
        content: {
          text: "Partial memory object",
          type: "text",
        },
      };

      await adapter.createMemory(partialMemory as Partial<Memory>, "memories");

      const retrievedMemory = await adapter.getMemoryById(partialMemory.id as UUID);
      expect(retrievedMemory).not.toBeNull();
      if (!retrievedMemory) throw new Error("Memory should exist");

      expect(retrievedMemory.id).toBe(partialMemory.id);
      expect(retrievedMemory.entityId).toBe(partialMemory.entityId);
      expect(retrievedMemory.roomId).toBe(partialMemory.roomId);
      const content = retrievedMemory.content as Record<string, unknown>;
      const partialContent = partialMemory.content as Record<string, unknown> | undefined;
      expect(content.text).toBe(partialContent?.text);
      expect(retrievedMemory.unique).toBe(true); // Default value
      expect(retrievedMemory.metadata).toBeDefined(); // Default empty object
    });
  });

  describe("Memory Batch Operations", () => {
    it("should delete all memories in a room", async () => {
      const uniqueEntityId = v4() as UUID;

      await adapter.createEntities([
        {
          id: uniqueEntityId,
          agentId: testAgentId,
          names: ["Test Entity"],
        } as Entity,
      ]);

      for (const memory of memoryTestMemories) {
        const testMemory = {
          ...memory,
          agentId: testAgentId,
          entityId: uniqueEntityId,
          roomId: testRoomId,
        };
        await adapter.createMemory(testMemory, "memories");
      }

      const countBefore = await adapter.countMemories(testRoomId, true, "memories");
      expect(countBefore).toBeGreaterThan(0);

      await adapter.deleteAllMemories(testRoomId, "memories");

      const countAfter = await adapter.countMemories(testRoomId, true, "memories");
      expect(countAfter).toBe(0);
    });

    it("should retrieve memories by multiple room IDs", async () => {
      const secondRoomId = v4() as UUID;
      await adapter.createRooms([
        {
          id: secondRoomId,
          name: "Memory Test Room 2",
          agentId: testAgentId,
          source: "test",
          type: ChannelType.GROUP,
          worldId: testWorldId,
        },
      ]);

      await adapter.createMemory(createTestMemory({ text: "mem1-room1" }), "memories");
      await adapter.createMemory(createTestMemory({ text: "mem2-room1" }), "memories");

      await adapter.createMemory(
        { ...createTestMemory({ text: "mem3-room2" }), roomId: secondRoomId },
        "memories"
      );

      const memories = await adapter.getMemoriesByRoomIds({
        roomIds: [testRoomId, secondRoomId],
        tableName: "memories",
      });

      expect(memories.length).toEqual(3);
    });
  });

  it("should properly convert metadata objects to JSON when updating only metadata", async () => {
    await adapter.ensureEmbeddingDimension(768);
    const memory = {
      entityId: testEntityId,
      roomId: testRoomId,
      worldId: testWorldId,
      agentId: testAgentId,
      content: { text: "Initial content" },
      embedding: Array.from({ length: 768 }, (_, i) => i / 768),
      metadata: {
        type: "initial",
        source: "test",
        tags: ["test"],
        nested: {
          value: 123,
          flag: true,
        },
      },
    };

    const memoryId = await adapter.createMemory(memory, "memory");
    expect(memoryId).toBeDefined();

    const complexMetadata = {
      type: "updated",
      source: "test-update",
      tags: ["updated", "test"],
      nested: {
        value: 456,
        flag: false,
        deeper: {
          array: [1, 2, 3],
          string: "test",
        },
      },
      timestamp: Date.now(),
    };

    // This should not throw a PostgreSQL jsonb cast error
    const updateResult = await adapter.updateMemory({
      id: memoryId,
      metadata: complexMetadata,
    });

    expect(updateResult).toBe(true);

    const updated = await adapter.getMemoryById(memoryId);
    expect(updated).not.toBeNull();
    if (!updated) throw new Error("Memory should exist");
    expect(updated.metadata).toEqual(complexMetadata);
    const content = updated.content as Record<string, unknown>;
    expect(content.text).toBe("Initial content");
  });
});
