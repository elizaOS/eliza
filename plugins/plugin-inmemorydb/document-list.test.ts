/**
 * Exercises the native document-list capability against the first-party
 * ephemeral adapter, including canonical metadata, room visibility, and
 * stable keyset pagination without mocks.
 */
import {
  DOCUMENT_LIST_QUERY_CAPABILITY_VERSION,
  type DocumentListCursor,
  type DocumentListQueryParams,
  type Memory,
  MemoryType,
  readDocumentMutationSnapshot,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const AGENT_ID = "50000000-0000-0000-0000-000000000001" as UUID;
const REQUESTER_ID = "50000000-0000-0000-0000-000000000002" as UUID;
const ROOM_A = "50000000-0000-0000-0000-000000000003" as UUID;
const ROOM_B = "50000000-0000-0000-0000-000000000004" as UUID;

function memory(
  index: number,
  roomId: UUID,
  metadata: Record<string, unknown> = {}
): Memory & { id: UUID } {
  const id = `50000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}` as UUID;
  return {
    id,
    agentId: AGENT_ID,
    entityId: REQUESTER_ID,
    roomId,
    createdAt: 1_000,
    content: { text: `Document ${index}` },
    metadata: {
      type: MemoryType.DOCUMENT,
      documentId: id,
      timestamp: 1_000,
      scope: "global",
      ...metadata,
    },
  };
}

describe("InMemoryDatabaseAdapter document list capability", () => {
  it("preserves document metadata and excludes mixed table types by room", async () => {
    const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), AGENT_ID);
    await adapter.initialize();
    const roomADocument = memory(1, ROOM_A);
    const roomBDocument = memory(2, ROOM_B);
    const fragment = memory(3, ROOM_A, {
      type: MemoryType.FRAGMENT,
      documentId: roomADocument.id,
      position: 0,
    });
    await adapter.createMemories(
      [roomADocument, roomBDocument, fragment].map((item) => ({
        memory: item,
        tableName: "documents",
      }))
    );

    expect(adapter.documentListQueryCapability).toBe(DOCUMENT_LIST_QUERY_CAPABILITY_VERSION);
    await expect(
      adapter.getMemories({
        tableName: "documents",
        roomId: ROOM_A,
        includeEmbedding: false,
      })
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: roomADocument.id,
          metadata: expect.objectContaining({ type: MemoryType.DOCUMENT }),
        }),
        expect.objectContaining({
          id: fragment.id,
          metadata: expect.objectContaining({ type: MemoryType.FRAGMENT }),
        }),
      ])
    );

    const result = await adapter.queryDocuments({
      agentId: AGENT_ID,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [ROOM_A],
      requesterRole: "USER",
      limit: 10,
      offset: 0,
    });

    expect(result.totalVisible).toBe(1);
    expect(result.documents.map((document) => document.id)).toEqual([roomADocument.id]);

    for (const requesterRole of ["OWNER", "RUNTIME", "AGENT"] as const) {
      const privileged = await adapter.queryDocuments({
        agentId: AGENT_ID,
        requesterEntityId: REQUESTER_ID,
        requesterRoomIds: [],
        requesterRole,
        limit: 10,
        offset: 0,
      });
      expect(new Set(privileged.documents.map((document) => document.id))).toEqual(
        new Set([roomADocument.id, roomBDocument.id])
      );
      expect(privileged.totalVisible).toBe(2);
    }
  });

  it("uses the id tiebreaker across complete keyset traversal", async () => {
    const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), AGENT_ID);
    await adapter.initialize();
    const documents = Array.from({ length: 11 }, (_, index) => memory(index, ROOM_A));
    await adapter.createMemories(
      documents.map((item) => ({ memory: item, tableName: "documents" }))
    );
    const params: DocumentListQueryParams = {
      agentId: AGENT_ID,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [ROOM_A],
      requesterRole: "RUNTIME",
      limit: 3,
      offset: 0,
    };
    const seen: UUID[] = [];
    let cursor: DocumentListCursor | undefined;
    do {
      const page = await adapter.queryDocuments({
        ...params,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(
        ...page.documents
          .map((document) => document.id)
          .filter((id): id is UUID => typeof id === "string")
      );
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    } while (cursor);

    expect(seen).toEqual(
      documents
        .map((document) => document.id)
        .filter((id): id is UUID => typeof id === "string")
        .sort((left, right) => right.localeCompare(left))
    );
    expect(new Set(seen).size).toBe(documents.length);
  });

  it("uses parent authorization for fragments and fails closed on malformed documents", async () => {
    const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), AGENT_ID);
    await adapter.initialize();
    const embedding = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));
    const visibleParent = memory(1, ROOM_A, {
      scope: "user-private",
      scopedToEntityId: REQUESTER_ID,
    });
    const hiddenParent = memory(2, ROOM_A, {
      scope: "user-private",
      scopedToEntityId: "50000000-0000-0000-0000-000000000099",
    });
    const malformedScope = memory(3, ROOM_A, { scope: "public" });
    const malformed = [
      malformedScope,
      memory(4, ROOM_A, { scope: "user-private" }),
      memory(5, ROOM_A, { addedBy: "not-a-uuid" }),
      memory(6, ROOM_A, { documentRevision: 1.5 }),
      memory(9, ROOM_A, { documentRevision: "1" }),
    ];
    const visibleFragment = memory(7, ROOM_A, {
      type: MemoryType.FRAGMENT,
      documentId: visibleParent.id,
      scope: "owner-private",
    });
    visibleFragment.embedding = embedding;
    const forgedFragment = memory(8, ROOM_A, {
      type: MemoryType.FRAGMENT,
      documentId: hiddenParent.id,
      scope: "global",
      scopedToEntityId: REQUESTER_ID,
    });
    const staleFragment = memory(10, ROOM_A, {
      type: MemoryType.FRAGMENT,
      documentId: visibleParent.id,
      documentRevision: 1,
    });
    await adapter.createMemories(
      [visibleParent, hiddenParent, ...malformed].map((item) => ({
        memory: item,
        tableName: "documents",
      }))
    );
    await adapter.createMemories(
      [visibleFragment, forgedFragment, staleFragment].map((item) => ({
        memory: item,
        tableName: "document_fragments",
      }))
    );
    const context = {
      agentId: AGENT_ID,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [ROOM_A],
      requesterRole: "USER" as const,
    };

    const listed = await adapter.queryDocuments({ ...context, limit: 20, offset: 0 });
    expect(listed.documents.map((item) => item.id)).toEqual([visibleParent.id]);
    await expect(
      adapter.getDocument({ ...context, documentId: malformedScope.id })
    ).resolves.toBeNull();
    const fragments = await adapter.queryDocumentFragments({ ...context, limit: 20 });
    expect(fragments.map((item) => item.id)).toEqual([visibleFragment.id]);
    const vectorFragments = await adapter.queryDocumentFragments({
      ...context,
      embedding,
      limit: 20,
      matchThreshold: 0.5,
    });
    expect(vectorFragments.map((item) => item.id)).toEqual([visibleFragment.id]);
    await expect(
      adapter.queryDocumentFragments({
        ...context,
        embedding: [Number.NaN],
        limit: 20,
      })
    ).rejects.toMatchObject({ code: "DOCUMENT_FRAGMENT_QUERY_INVALID" });

    const owner = await adapter.queryDocuments({
      ...context,
      requesterRole: "OWNER",
      requesterRoomIds: [],
      limit: 20,
      offset: 0,
    });
    expect(new Set(owner.documents.map((item) => item.id))).toEqual(
      new Set([visibleParent.id, hiddenParent.id])
    );
  });

  it("rejects stale update and delete snapshots after ownership changes", async () => {
    const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), AGENT_ID);
    await adapter.initialize();
    const original = memory(1, ROOM_A, {
      scope: "user-private",
      scopedToEntityId: REQUESTER_ID,
      documentRevision: 0,
    });
    await adapter.createMemories([{ memory: original, tableName: "documents" }]);
    const context = {
      agentId: AGENT_ID,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [ROOM_A],
      requesterRole: "USER" as const,
    };
    const observed = await adapter.getDocument({ ...context, documentId: original.id });
    if (!observed) throw new Error("Expected the original document to be visible");
    const snapshot = readDocumentMutationSnapshot(observed);
    if (!snapshot) throw new Error("Expected a valid document mutation snapshot");

    await adapter.updateMemories([
      {
        id: original.id,
        metadata: { ...original.metadata, scope: "owner-private" },
      },
    ]);
    await expect(
      adapter.compareAndSwapDocument({
        ...context,
        documentId: original.id,
        expected: snapshot,
        replacement: { ...original, content: { text: "stale write" } },
      })
    ).resolves.toEqual({ status: "conflict" });

    await adapter.updateMemories([
      {
        id: original.id,
        metadata: {
          ...original.metadata,
          scope: "user-private",
          scopedToEntityId: "50000000-0000-0000-0000-000000000099",
        },
      },
    ]);
    await expect(
      adapter.deleteDocumentWithSnapshot({
        ...context,
        documentId: original.id,
        expected: snapshot,
      })
    ).resolves.toEqual({ status: "conflict" });
    await expect(adapter.getMemoriesByIds([original.id], "documents")).resolves.toHaveLength(1);
  });

  it("atomically replaces a parent and its complete fragment generation", async () => {
    const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), AGENT_ID);
    await adapter.initialize();
    const original = memory(1, ROOM_A, { documentRevision: 0 });
    const oldFragment = {
      ...memory(2, ROOM_A),
      content: { text: "old fragment" },
      metadata: {
        type: MemoryType.FRAGMENT,
        documentId: original.id,
        documentRevision: 0,
        position: 0,
      },
    };
    await adapter.createMemories([
      { memory: original, tableName: "documents" },
      { memory: oldFragment, tableName: "document_fragments" },
    ]);
    const expected = readDocumentMutationSnapshot(original);
    if (!expected) throw new Error("Expected a valid document mutation snapshot");
    const replacement = {
      ...original,
      content: { text: "new body" },
      metadata: { ...original.metadata, documentRevision: 1 },
    };
    const newFragment = {
      ...oldFragment,
      id: memory(3, ROOM_A).id,
      content: { text: "new fragment" },
      metadata: { ...oldFragment.metadata, documentRevision: 1 },
    };
    await expect(
      adapter.replaceDocumentRevision({
        agentId: AGENT_ID,
        requesterEntityId: REQUESTER_ID,
        requesterRoomIds: [],
        requesterRole: "OWNER",
        documentId: original.id,
        expected,
        replacement,
        fragments: [newFragment],
      })
    ).resolves.toMatchObject({ status: "updated" });
    await expect(adapter.getMemoriesByIds([oldFragment.id], "document_fragments")).resolves.toEqual(
      []
    );
    await expect(adapter.getMemoriesByIds([original.id], "documents")).resolves.toEqual([
      expect.objectContaining({
        content: { text: "new body" },
        metadata: expect.objectContaining({ documentRevision: 1 }),
      }),
    ]);
    await expect(adapter.getMemoriesByIds([newFragment.id], "document_fragments")).resolves.toEqual(
      [
        expect.objectContaining({
          content: { text: "new fragment" },
          metadata: expect.objectContaining({ documentRevision: 1 }),
        }),
      ]
    );
  });
});
