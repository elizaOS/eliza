/**
 * Exercises complete ranked document-fragment traversal against the real SQL
 * adapter. The vectors and UUIDs deliberately tie so PGlite and PostgreSQL
 * must expose the same stable order while concurrent writes are distinguished
 * from the snapshot being traversed.
 */
import {
  ChannelType,
  type Memory,
  MemoryType,
  type Room,
  type UUID,
  type World,
} from "@elizaos/core";
import { v4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { embeddingTable, memoryTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

const DIMS = 384;
const REQUESTER_ID = "25150000-0000-4000-8000-000000000001" as UUID;
const DOCUMENT_ID = "25150000-0000-4000-8000-000000000002" as UUID;
const ORIGINAL_IDS = [
  "25150000-0000-4000-8000-000000000104",
  "25150000-0000-4000-8000-000000000103",
  "25150000-0000-4000-8000-000000000102",
  "25150000-0000-4000-8000-000000000101",
] as UUID[];

function vectorAtSimilarity(similarity: number): number[] {
  const orthogonal = Math.sqrt(Math.max(0, 1 - similarity * similarity));
  return Array.from({ length: DIMS }, (_, index) => {
    if (index === 0) return similarity;
    if (index === 1) return orthogonal;
    return 0;
  });
}

const QUERY = vectorAtSimilarity(1);

describe("issue #25150 ranked retrieval keyset (real SQL)", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let agentId: UUID;
  let roomId: UUID;
  let worldId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("issue_25150_retrieval_keyset");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    agentId = setup.testAgentId;
    roomId = v4() as UUID;
    worldId = v4() as UUID;

    await adapter.createWorld({
      id: worldId,
      agentId,
      name: "Issue 25150 world",
      serverId: "issue-25150",
    } as World);
    await adapter.createRooms([
      {
        id: roomId,
        agentId,
        worldId,
        name: "Issue 25150 room",
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
    ]);
    await adapter.createEntities([{ id: REQUESTER_ID, agentId, names: ["Issue 25150 requester"] }]);
  }, 120_000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    const db = adapter.getDatabase() as DrizzleDatabase;
    await db.delete(embeddingTable);
    await db.delete(memoryTable);
  });

  function parent(content = "stable source"): Memory {
    return {
      id: DOCUMENT_ID,
      agentId,
      entityId: REQUESTER_ID,
      roomId,
      worldId,
      createdAt: 1_000,
      content: { text: content },
      metadata: {
        type: MemoryType.DOCUMENT,
        documentId: DOCUMENT_ID,
        title: "Stable source",
        scope: "global",
        timestamp: 1_000,
        documentRevision: 0,
      },
    };
  }

  function fragment(id: UUID, similarity: number, createdAt = 2_000): Memory {
    return {
      id,
      agentId,
      entityId: REQUESTER_ID,
      roomId,
      worldId,
      createdAt,
      content: { text: `fragment ${id}` },
      embedding: vectorAtSimilarity(similarity),
      metadata: {
        type: MemoryType.FRAGMENT,
        documentId: DOCUMENT_ID,
        position: Number(id.slice(-3)),
        timestamp: createdAt,
        documentRevision: 0,
      },
    };
  }

  async function seedOriginal(): Promise<void> {
    await adapter.createMemory(parent(), "documents");
    await adapter.createMemories(
      ORIGINAL_IDS.map((id) => ({
        memory: fragment(id, 0.8),
        tableName: "document_fragments",
      }))
    );
  }

  const context = () => ({
    agentId,
    requesterEntityId: REQUESTER_ID,
    requesterRoomIds: [roomId],
    requesterRole: "RUNTIME" as const,
    embedding: QUERY,
    matchThreshold: 0,
  });

  it("orders tied semantic scores by createdAt and UUID and continues exactly once", async () => {
    await seedOriginal();

    const first = await adapter.queryDocumentFragmentsPage({ ...context(), limit: 2 });
    if (!first.nextCursor) throw new Error("expected a continuation cursor");
    const second = await adapter.queryDocumentFragmentsPage({
      ...context(),
      limit: 2,
      cursor: first.nextCursor,
    });

    expect([...first.items, ...second.items].map((memory) => memory.id)).toEqual(ORIGINAL_IDS);
    expect(new Set([...first.items, ...second.items].map((memory) => memory.id))).toHaveLength(4);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();
  });

  it("keeps an in-progress traversal stable when a newer best match is appended", async () => {
    await seedOriginal();
    const first = await adapter.queryDocumentFragmentsPage({ ...context(), limit: 2 });
    if (!first.nextCursor) throw new Error("expected a continuation cursor");

    const appendedId = "25150000-0000-4000-8000-000000000999" as UUID;
    await adapter.createMemory(fragment(appendedId, 0.99, 3_000), "document_fragments");
    const second = await adapter.queryDocumentFragmentsPage({
      ...context(),
      limit: 2,
      cursor: first.nextCursor,
    });

    const seen = [...first.items, ...second.items].map((memory) => memory.id);
    expect(seen).toEqual(ORIGINAL_IDS);
    expect(new Set(seen)).toHaveLength(seen.length);
    expect(seen).not.toContain(appendedId);
  });

  it("returns an actionable conflict when the traversed source mutates", async () => {
    await seedOriginal();
    const first = await adapter.queryDocumentFragmentsPage({ ...context(), limit: 2 });
    if (!first.nextCursor) throw new Error("expected a continuation cursor");
    await adapter.updateMemories([
      { id: ORIGINAL_IDS[0], content: { text: "mutated ranked fragment" } },
    ]);

    await expect(
      adapter.queryDocumentFragmentsPage({
        ...context(),
        limit: 2,
        cursor: first.nextCursor,
      })
    ).rejects.toMatchObject({
      code: "RETRIEVAL_SNAPSHOT_CONFLICT",
      context: { action: "restart-from-first-page" },
    });
  });

  it("uses the real vector operator for the same semantic vectors", async () => {
    await adapter.createMemory(parent(), "documents");
    const closeId = "25150000-0000-4000-8000-000000000201" as UUID;
    const farId = "25150000-0000-4000-8000-000000000202" as UUID;
    const negativeId = "25150000-0000-4000-8000-000000000203" as UUID;
    await adapter.createMemories([
      { memory: fragment(closeId, 0.9), tableName: "document_fragments" },
      { memory: fragment(farId, 0.2), tableName: "document_fragments" },
      { memory: fragment(negativeId, -0.2), tableName: "document_fragments" },
    ]);

    const page = await adapter.queryDocumentFragmentsPage({ ...context(), limit: 10 });
    expect(page.items.map((memory) => memory.id)).toEqual([closeId, farId]);
    expect(page.items.map((memory) => memory.similarity)).toEqual([
      expect.closeTo(0.9, 5),
      expect.closeTo(0.2, 5),
    ]);

    const memoryPage = await adapter.searchMemoriesPage({
      embedding: QUERY,
      tableName: "document_fragments",
      match_threshold: 0,
      limit: 1,
    });
    if (!memoryPage.nextCursor) throw new Error("expected a memory continuation cursor");
    const memoryContinuation = await adapter.searchMemoriesPage({
      embedding: QUERY,
      tableName: "document_fragments",
      match_threshold: 0,
      limit: 1,
      cursor: memoryPage.nextCursor,
    });
    const memoryItems = [...memoryPage.items, ...memoryContinuation.items];
    expect(memoryItems.map((memory) => memory.id)).toEqual([closeId, farId]);
    expect(memoryItems.map((memory) => memory.similarity)).toEqual([
      expect.closeTo(0.9, 5),
      expect.closeTo(0.2, 5),
    ]);
    const unthresholded = await adapter.searchMemoriesPage({
      embedding: QUERY,
      tableName: "document_fragments",
      limit: 10,
    });
    expect(unthresholded.items.map((memory) => memory.id)).toEqual([closeId, farId, negativeId]);
  });
});
