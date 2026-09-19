/** Exercises same-width vector migration and stale-writer rejection against a real isolated SQL adapter. */
import { ChannelType, type Entity, type Memory, type Room, type UUID } from "@elizaos/core";
import { eq, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  timestamp,
  uuid,
  vector as vectorColumn,
} from "drizzle-orm/pg-core";
import { v4 } from "uuid";
import { expect, test } from "vitest";
import { DatabaseMigrationService } from "../../migration-service";
import * as schema from "../../schema";
import { embeddingTable, memoryTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { mockCharacter } from "../schema-data";
import { createIsolatedTestDatabaseForMigration } from "../test-helpers";

// The previous on-disk contract has neither representation metadata nor a write fence.
const legacyEmbeddingTable = pgTable(
  "embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    memoryId: uuid("memory_id").references(() => memoryTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    dim384: vectorColumn("dim_384", { dimensions: 384 }),
    dim512: vectorColumn("dim_512", { dimensions: 512 }),
    dim768: vectorColumn("dim_768", { dimensions: 768 }),
    dim1024: vectorColumn("dim_1024", { dimensions: 1024 }),
    dim1536: vectorColumn("dim_1536", { dimensions: 1536 }),
    dim2048: vectorColumn("dim_2048", { dimensions: 2048 }),
    dim3072: vectorColumn("dim_3072", { dimensions: 3072 }),
  },
  (table) => [
    check("embedding_source_check", sql`"memory_id" IS NOT NULL`),
    index("idx_embedding_memory").on(table.memoryId),
    foreignKey({
      name: "fk_embedding_memory",
      columns: [table.memoryId],
      foreignColumns: [memoryTable.id],
    }).onDelete("cascade"),
  ]
);

const vector = (axis: number) =>
  Array.from({ length: 384 }, (_, index) => (index === axis ? 1 : 0));

test("retains source memories while replacing only explicitly identified embeddings", async () => {
  const { adapter, cleanup, testAgentId } =
    await createIsolatedTestDatabaseForMigration("embedding-space");
  try {
    const db = adapter.getDatabase() as DrizzleDatabase;
    const migrations = new DatabaseMigrationService({ databaseBackend: "pglite" });
    await migrations.initializeWithDatabase(db);
    migrations.registerSchema("@elizaos/plugin-sql", {
      ...schema,
      embeddingTable: legacyEmbeddingTable,
    });
    await migrations.runAllPluginMigrations();
    await adapter.createAgent({
      ...mockCharacter,
      id: testAgentId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const entityId = v4() as UUID;
    const roomId = v4() as UUID;
    const memoryId = v4() as UUID;
    await adapter.createEntities([
      { id: entityId, agentId: testAgentId, names: ["Owner"] } as Entity,
    ]);
    await adapter.createRooms([
      {
        id: roomId,
        agentId: testAgentId,
        name: "Migration",
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
    ]);
    await adapter.ensureEmbeddingDimension(384);
    const source = "The complete original memory must survive the embedding model change.";
    const memory: Memory = {
      id: memoryId,
      agentId: testAgentId,
      entityId,
      roomId,
      content: { text: source },
    };
    await adapter.createMemory(memory, "embedding_migration");
    const foreignAgent = v4() as UUID;
    const foreignMemory = v4() as UUID;
    await adapter.createAgent({
      ...mockCharacter,
      id: foreignAgent,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await adapter.createMemory(
      { ...memory, id: foreignMemory, agentId: foreignAgent },
      "embedding_migration"
    );
    await db.insert(legacyEmbeddingTable).values([
      { memoryId, dim384: vector(0) },
      { memoryId: foreignMemory, dim384: vector(0) },
    ]);
    migrations.registerSchema("@elizaos/plugin-sql", schema);
    await migrations.runAllPluginMigrations();
    const cached = () =>
      adapter.getCachedEmbeddings({
        query_table_name: "embedding_migration",
        query_threshold: 0,
        query_input: source,
        query_field_name: "content",
        query_field_sub_name: "text",
        query_match_count: 10,
      });
    expect((await cached()).map((row) => row.embedding)).toEqual([vector(0)]);

    expect((await adapter.getMemoryById(memoryId))?.embedding).toEqual(vector(0));

    const activation = adapter.ensureEmbeddingSpace("bge-small-en-v1.5:cls:l2:384");
    await expect(adapter.ensureEmbeddingSpace("other-model:cls:l2:384")).rejects.toMatchObject({
      code: "EMBEDDING_SPACE_CHANGED",
    });
    expect(await activation).toEqual([memoryId]);
    const pending = await adapter.getMemoryById(memoryId);
    expect(pending?.content.text).toBe(source);
    expect(pending?.embedding).toBeUndefined();
    expect(await cached()).toEqual([]);
    expect(
      await adapter.searchMemories({
        tableName: "embedding_migration",
        embedding: vector(0),
        count: 10,
      })
    ).toEqual([]);

    const expected = { agentId: testAgentId, entityId, roomId, text: source };
    expect(
      await adapter.updateMemoryEmbedding({
        id: memoryId,
        expected: { ...expected, text: "A stale source" },
        embedding: vector(1),
      })
    ).toBe(false);
    expect((await adapter.getMemoryById(memoryId))?.embedding).toBeUndefined();
    expect(
      await adapter.updateMemoryEmbedding({
        id: memoryId,
        expected,
        embedding: vector(1),
      })
    ).toBe(true);
    expect((await adapter.getMemoryById(memoryId))?.embedding).toEqual(vector(1));
    expect(await adapter.ensureEmbeddingSpace("bge-small-en-v1.5:cls:l2:384")).toEqual([]);
    expect(
      (
        await adapter.searchMemories({
          tableName: "embedding_migration",
          embedding: vector(1),
          count: 10,
        })
      ).map((row) => row.id)
    ).toEqual([memoryId]);

    // An older binary updates the vector without replacing the representation's write nonce.
    const foreignRows = await db
      .select()
      .from(embeddingTable)
      .where(eq(embeddingTable.memoryId, foreignMemory));
    expect(foreignRows[0]?.spaceId).toBeNull();
    expect(foreignRows[0]?.dim384).toEqual(vector(0));
    expect((await cached()).map((row) => row.embedding)).toEqual([vector(1)]);

    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(memoryTable)
          .set({ content: { text: "A stale writer changed the source." } })
          .where(eq(memoryTable.id, memoryId));
        await tx
          .update(legacyEmbeddingTable)
          .set({ dim384: vector(0) })
          .where(eq(legacyEmbeddingTable.memoryId, memoryId));
      })
    ).rejects.toThrow();
    await expect(
      db
        .update(embeddingTable)
        .set({ dim384: vector(0), spaceId: null, writeNonce: null })
        .where(eq(embeddingTable.memoryId, memoryId))
    ).rejects.toThrow();
    expect((await adapter.getMemoryById(memoryId))?.embedding).toEqual(vector(1));
    expect((await adapter.getMemoryById(memoryId))?.content.text).toBe(source);
    expect(
      await adapter.updateMemoryEmbedding({
        id: memoryId,
        expected,
        embedding: vector(2),
      })
    ).toBe(true);
    expect((await adapter.getMemoryById(memoryId))?.embedding).toEqual(vector(2));
    expect((await adapter.getMemoryById(memoryId))?.content.text).toBe(source);
    await expect(adapter.ensureEmbeddingSpace("other-model:cls:l2:384")).rejects.toMatchObject({
      code: "EMBEDDING_SPACE_CHANGED",
    });
    await expect(adapter.ensureEmbeddingDimension(768)).rejects.toMatchObject({
      code: "EMBEDDING_SPACE_CHANGED",
    });
  } finally {
    await cleanup();
  }
}, 120_000);
