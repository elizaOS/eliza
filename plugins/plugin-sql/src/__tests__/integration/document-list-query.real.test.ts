/**
 * Compares the bounded document-list query across real PGlite/Postgres and the
 * core in-memory fallback, including RLS context, visibility, and keyset ties.
 */
import {
  ChannelType,
  type DocumentListCursor,
  type DocumentListQueryParams,
  type Entity,
  InMemoryDatabaseAdapter,
  type Memory,
  MemoryType,
  type Room,
  type UUID,
  type World,
} from "@elizaos/core";
import { sql } from "drizzle-orm";
import { v4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { embeddingTable, memoryTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

const REQUESTER_ID = "10000000-0000-0000-0000-000000000001" as UUID;
const OTHER_ENTITY_ID = "10000000-0000-0000-0000-000000000002" as UUID;

describe("document list query (real SQL parity)", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let agentId: UUID;
  let roomId: UUID;
  let worldId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("document_list_query");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    agentId = setup.testAgentId;
    worldId = v4() as UUID;
    roomId = v4() as UUID;

    await adapter.createWorld({
      id: worldId,
      agentId,
      name: "Document query world",
      serverId: "document-query",
    } as World);
    await adapter.createRooms([
      {
        id: roomId,
        agentId,
        worldId,
        name: "documents",
        source: "test",
        type: ChannelType.DM,
      } as Room,
    ]);
    await adapter.createEntities([
      {
        id: REQUESTER_ID,
        agentId,
        names: ["Requester"],
      } as Entity,
      {
        id: OTHER_ENTITY_ID,
        agentId,
        names: ["Other"],
      } as Entity,
    ]);
    await adapter.addParticipant(REQUESTER_ID, roomId);
    await adapter.addParticipant(OTHER_ENTITY_ID, roomId);
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    const db = adapter.getDatabase() as DrizzleDatabase;
    await db.delete(embeddingTable);
    await db.delete(memoryTable);
  });

  function document(
    index: number,
    overrides: Partial<Memory> & { metadata?: Record<string, unknown> } = {}
  ): Memory {
    const { metadata, ...memoryOverrides } = overrides;
    const id = `30000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}` as UUID;
    return {
      id,
      agentId,
      entityId: REQUESTER_ID,
      roomId,
      worldId,
      createdAt: 10_000,
      content: { text: `Document body ${index}` },
      metadata: {
        type: MemoryType.DOCUMENT,
        documentId: id,
        title: `Document ${index}`,
        scope: "global",
        timestamp: 10_000,
        tags: ["archive"],
        ...metadata,
      },
      ...memoryOverrides,
    };
  }

  async function seedSql(documents: Memory[]): Promise<void> {
    await adapter.createMemories(documents.map((memory) => ({ memory, tableName: "documents" })));
  }

  async function seedInMemory(documents: Memory[]): Promise<InMemoryDatabaseAdapter> {
    const inMemory = new InMemoryDatabaseAdapter();
    await inMemory.initialize();
    await inMemory.createMemories(documents.map((memory) => ({ memory, tableName: "documents" })));
    return inMemory;
  }

  const ids = (memories: Memory[]): UUID[] =>
    memories.map((memory) => memory.id).filter((id): id is UUID => typeof id === "string");

  it("keeps entityId as isolation context instead of a row predicate", async () => {
    const documents = [document(1), document(2, { entityId: OTHER_ENTITY_ID })];
    await seedSql(documents);
    const inMemory = await seedInMemory(documents);

    const sqlRows = await adapter.getMemories({
      tableName: "documents",
      agentId,
      entityId: REQUESTER_ID,
      includeEmbedding: false,
    });
    const inMemoryRows = await inMemory.getMemories({
      tableName: "documents",
      agentId,
      entityId: REQUESTER_ID,
      includeEmbedding: false,
    });

    expect(ids(sqlRows)).toEqual(ids(inMemoryRows));
    expect(new Set(ids(sqlRows))).toEqual(new Set(ids(documents)));
  });

  it("matches visibility, filters, counts, and fallback pages across adapters", async () => {
    const documents = [
      document(1),
      document(2, {
        metadata: {
          scope: "user-private",
          scopedToEntityId: REQUESTER_ID,
        },
      }),
      document(3, {
        entityId: OTHER_ENTITY_ID,
        metadata: {
          scope: "user-private",
          scopedToEntityId: OTHER_ENTITY_ID,
        },
      }),
      document(4, { metadata: { scope: "owner-private" } }),
      document(5, { metadata: { scope: "agent-private" } }),
    ];
    await seedSql(documents);
    const inMemory = await seedInMemory(documents);
    const params: DocumentListQueryParams = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "USER",
      query: "missing",
      limit: 1,
      offset: 0,
    };
    const withEntityContext = vi.spyOn(
      adapter as unknown as {
        withEntityContext: (
          entityId: UUID | null,
          callback: (tx: unknown) => Promise<unknown>
        ) => Promise<unknown>;
      },
      "withEntityContext"
    );

    const sqlResult = await adapter.queryDocuments(params);
    const inMemoryResult = await inMemory.queryDocuments(params);

    expect(withEntityContext).toHaveBeenCalledWith(REQUESTER_ID, expect.any(Function));
    expect(sqlResult).toMatchObject({
      totalVisible: 2,
      totalAvailable: 2,
      totalMatched: 0,
      documents: [],
      availableHasMore: true,
    });
    expect(sqlResult.availableNextCursor).toBeDefined();
    expect(ids(sqlResult.availableDocuments)).toEqual(ids(inMemoryResult.availableDocuments));
    expect(sqlResult).toEqual(inMemoryResult);

    const secondSqlPage = await adapter.queryDocuments({
      ...params,
      offset: 1,
    });
    const secondInMemoryPage = await inMemory.queryDocuments({
      ...params,
      offset: 1,
    });
    expect(secondSqlPage).toMatchObject({
      totalAvailable: 2,
      availableHasMore: false,
    });
    expect(secondSqlPage).toEqual(secondInMemoryPage);
    expect(ids(secondSqlPage.availableDocuments)).not.toEqual(ids(sqlResult.availableDocuments));

    const cursorSqlPage = await adapter.queryDocuments({
      ...params,
      cursor: sqlResult.availableNextCursor,
    });
    expect(cursorSqlPage.availableDocuments).toEqual(secondSqlPage.availableDocuments);
    expect(cursorSqlPage.availableHasMore).toBe(false);

    const ownerResult = await adapter.queryDocuments({
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "OWNER",
      limit: 10,
      offset: 0,
    });
    expect(ownerResult).toMatchObject({
      totalVisible: 5,
      totalAvailable: 5,
      totalMatched: 5,
    });
  });

  it("does not skip or duplicate equal-timestamp rows across keyset pages", async () => {
    const documents = Array.from({ length: 151 }, (_, index) => document(index));
    await seedSql(documents);
    const inMemory = await seedInMemory(documents);
    const baseParams: DocumentListQueryParams = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "RUNTIME",
      limit: 37,
      offset: 0,
    };

    const collect = async (
      query: (
        params: DocumentListQueryParams
      ) => Promise<{ documents: Memory[]; hasMore: boolean; nextCursor?: DocumentListCursor }>
    ): Promise<UUID[]> => {
      const seen: UUID[] = [];
      let cursor: DocumentListCursor | undefined;
      do {
        const page = await query({
          ...baseParams,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...ids(page.documents));
        cursor = page.nextCursor;
        if (!page.hasMore) break;
        expect(cursor).toBeDefined();
      } while (cursor);
      return seen;
    };

    const sqlIds = await collect((params) => adapter.queryDocuments(params));
    const inMemoryIds = await collect((params) => inMemory.queryDocuments(params));

    expect(sqlIds).toHaveLength(151);
    expect(new Set(sqlIds).size).toBe(151);
    expect(sqlIds).toEqual(inMemoryIds);
  });

  it("normalizes microsecond database timestamps before applying keyset cursors", async () => {
    const documents = [document(1), document(2), document(3)];
    await seedSql(documents);
    const db = adapter.getDatabase() as DrizzleDatabase;
    await db.execute(
      sql`UPDATE ${memoryTable}
          SET created_at = CASE id
            WHEN ${documents[0]?.id}::uuid THEN '2026-01-01 00:00:00.123900'::timestamp
            WHEN ${documents[1]?.id}::uuid THEN '2026-01-01 00:00:00.123800'::timestamp
            ELSE '2026-01-01 00:00:00.123700'::timestamp
          END`
    );
    const params: DocumentListQueryParams = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "RUNTIME",
      limit: 1,
      offset: 0,
    };
    const seen: UUID[] = [];
    let cursor: DocumentListCursor | undefined;
    do {
      const page = await adapter.queryDocuments({
        ...params,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...ids(page.documents));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    } while (cursor);

    expect(seen).toEqual(ids(documents).sort((left, right) => right.localeCompare(left)));
    expect(new Set(seen).size).toBe(3);
  });

  it("excludes fragments stored in the documents table across adapters", async () => {
    const canonical = document(1);
    const fragment = document(2, {
      metadata: {
        type: MemoryType.FRAGMENT,
        documentId: canonical.id,
        position: 0,
        timestamp: 10_000,
      },
    });
    await seedSql([canonical, fragment]);
    const inMemory = await seedInMemory([canonical, fragment]);
    const params: DocumentListQueryParams = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "RUNTIME",
      limit: 10,
      offset: 0,
    };

    const sqlResult = await adapter.queryDocuments(params);
    const inMemoryResult = await inMemory.queryDocuments(params);

    expect(ids(sqlResult.documents)).toEqual([canonical.id]);
    expect(sqlResult).toEqual(inMemoryResult);
    expect(sqlResult.totalVisible).toBe(1);
  });

  it("keeps each count and page coherent while writes race the query", async () => {
    await seedSql(Array.from({ length: 10 }, (_, index) => document(index)));
    const params: DocumentListQueryParams = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "RUNTIME",
      limit: 100,
      offset: 0,
    };

    const reads = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const [result] = await Promise.all([
          adapter.queryDocuments(params),
          seedSql([document(100 + index)]),
        ]);
        return result;
      })
    );

    for (const result of reads) {
      expect(result.totalVisible).toBe(result.documents.length);
      expect(result.totalAvailable).toBe(result.documents.length);
      expect(result.totalMatched).toBe(result.documents.length);
      expect(result.hasMore).toBe(false);
    }
  });

  it("rejects unbounded offsets before issuing a database query", async () => {
    await expect(
      adapter.queryDocuments({
        agentId,
        requesterEntityId: REQUESTER_ID,
        requesterRoomIds: [roomId],
        requesterRole: "RUNTIME",
        limit: 10,
        offset: 10_001,
      })
    ).rejects.toMatchObject({
      code: "DOCUMENT_LIST_INVALID_PAGINATION",
    });
  });

  it("installs the composite index supporting document keyset order", async () => {
    const db = adapter.getDatabase() as DrizzleDatabase;
    const result = await db.execute(sql`
      SELECT indexdef
      FROM pg_indexes
      WHERE indexname = 'idx_memories_document_list_order'
    `);
    const definition = String(result.rows[0]?.indexdef ?? "");

    expect(result.rows).toHaveLength(1);
    expect(definition).toContain("date_trunc");
    expect(definition).toContain("metadata");
    expect(definition).toContain("type");
  });

  it("pushes metadata, text, and document timestamp filters down with parity", async () => {
    const documents = [
      document(1, {
        metadata: {
          title: "Quarterly Launch Needle",
          scope: "global",
          scopedToEntityId: REQUESTER_ID,
          addedBy: REQUESTER_ID,
          tags: ["archive", "launch"],
          timestamp: 5_000,
        },
      }),
      document(2, {
        metadata: {
          title: "Quarterly Launch Needle",
          scope: "global",
          scopedToEntityId: REQUESTER_ID,
          addedBy: REQUESTER_ID,
          tags: ["archive"],
          timestamp: 5_000,
        },
      }),
      document(3, {
        metadata: {
          title: "Quarterly Launch Needle",
          scope: "global",
          scopedToEntityId: REQUESTER_ID,
          addedBy: REQUESTER_ID,
          tags: ["archive", "launch"],
          timestamp: 50_000,
        },
      }),
    ];
    await seedSql(documents);
    const inMemory = await seedInMemory(documents);
    const params: DocumentListQueryParams = {
      agentId,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [roomId],
      requesterRole: "RUNTIME",
      query: "launch needle",
      scope: "global",
      scopedToEntityId: REQUESTER_ID,
      addedBy: REQUESTER_ID,
      tags: ["archive", "launch"],
      timeRangeStart: 4_000,
      timeRangeEnd: 6_000,
      limit: 10,
      offset: 0,
    };

    const sqlResult = await adapter.queryDocuments(params);
    const inMemoryResult = await inMemory.queryDocuments(params);

    expect(ids(sqlResult.documents)).toEqual([documents[0]?.id]);
    expect(sqlResult).toEqual(inMemoryResult);
    expect(sqlResult).toMatchObject({
      totalVisible: 3,
      totalAvailable: 1,
      totalMatched: 1,
      hasMore: false,
    });
  });
});
