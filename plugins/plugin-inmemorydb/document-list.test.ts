/**
 * Exercises the native document-list capability against the first-party
 * ephemeral adapter, including canonical metadata, room visibility, and
 * stable keyset pagination without mocks.
 */
import {
  DOCUMENT_LIST_QUERY_CAPABILITY_VERSION,
  type DocumentListCursor,
  type DocumentListQueryParams,
  type Entity,
  type Memory,
  MemoryType,
  readDocumentMutationSnapshot,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const AGENT_ID = "50000000-0000-0000-0000-000000000001" as UUID;
const REQUESTER_ID = "50000000-0000-0000-0000-000000000002" as UUID;
const ROOM_A = "50000000-0000-0000-0000-000000000003" as UUID;
const ROOM_B = "50000000-0000-0000-0000-000000000004" as UUID;

class BlockingBatchStorage extends MemoryStorage {
  readonly batchStarted: Promise<void>;
  private markBatchStarted!: () => void;
  private releaseBatch!: () => void;
  private readonly batchRelease: Promise<void>;

  constructor() {
    super();
    this.batchStarted = new Promise((resolve) => {
      this.markBatchStarted = resolve;
    });
    this.batchRelease = new Promise((resolve) => {
      this.releaseBatch = resolve;
    });
  }

  release(): void {
    this.releaseBatch();
  }

  override async applyBatch(batch: {
    collection: string;
    deletes: string[];
    sets: Array<{ id: string; data: unknown }>;
  }): Promise<void> {
    this.markBatchStarted();
    await this.batchRelease;
    await super.applyBatch(batch);
  }
}

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

async function grantCurrentRoom(adapter: InMemoryDatabaseAdapter, roomId: UUID): Promise<void> {
  await adapter.createRoomParticipants([REQUESTER_ID], roomId);
  const result = await adapter.updateRoomMembershipEvidence({
    evidence: {
      entityId: REQUESTER_ID,
      roomId,
      source: "runtime:local",
      state: "member",
      observedAt: Date.now(),
      generation: 1,
    },
    expectedGeneration: null,
  });
  if (result.status !== "updated") throw new Error("room membership seed failed");
}

describe("InMemoryDatabaseAdapter document list capability", () => {
  it("rejects caller-supplied room ids without current membership evidence", async () => {
    const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), AGENT_ID);
    await adapter.initialize();
    const document = memory(98, ROOM_A);
    await adapter.createMemories([{ memory: document, tableName: "documents" }]);

    await expect(
      adapter.queryDocuments({
        agentId: AGENT_ID,
        requesterEntityId: REQUESTER_ID,
        requesterRoomIds: [ROOM_A],
        requesterRole: "USER",
        limit: 10,
        offset: 0,
      })
    ).resolves.toMatchObject({ documents: [], totalVisible: 0 });
  });

  it("orders membership revocation before a subsequently queued document read", async () => {
    const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), AGENT_ID);
    await adapter.initialize();
    await grantCurrentRoom(adapter, ROOM_A);
    const document = memory(97, ROOM_A);
    await adapter.createMemories([{ memory: document, tableName: "documents" }]);

    const revoke = adapter.updateRoomMembershipEvidence({
      evidence: {
        entityId: REQUESTER_ID,
        roomId: ROOM_A,
        source: "runtime:local",
        state: "nonmember",
        observedAt: Date.now(),
        generation: 2,
      },
      expectedGeneration: 1,
    });
    const read = adapter.queryDocuments({
      agentId: AGENT_ID,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [ROOM_A],
      requesterRole: "USER",
      limit: 10,
      offset: 0,
    });

    await expect(revoke).resolves.toMatchObject({ status: "updated" });
    await expect(read).resolves.toMatchObject({ documents: [], totalVisible: 0 });
  });

  it("enforces direct-grant replacement inside the ephemeral adapter lock", async () => {
    const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), AGENT_ID);
    await adapter.initialize();
    await grantCurrentRoom(adapter, ROOM_A);
    const granteeId = "50000000-0000-0000-0000-000000000099" as UUID;
    await adapter.createEntities([
      { id: granteeId, agentId: AGENT_ID, names: ["Grantee"] } as Entity,
    ]);
    const document = memory(99, ROOM_A, { documentRevision: 0 });
    await adapter.createMemories([{ memory: document, tableName: "documents" }]);
    const expected = readDocumentMutationSnapshot(document);
    expect(expected).not.toBeNull();
    if (!expected) throw new Error("test document snapshot must be valid");

    await expect(
      adapter.updateDocumentDirectGrants({
        agentId: AGENT_ID,
        documentId: document.id,
        requesterEntityId: REQUESTER_ID,
        requesterRoomIds: [ROOM_A],
        requesterRole: "ADMIN",
        expected,
        directGrantEntityIds: [granteeId],
      })
    ).resolves.toMatchObject({
      status: "updated",
      document: { metadata: { directGrantEntityIds: [granteeId] } },
    });
    await expect(
      adapter.updateDocumentDirectGrants({
        agentId: AGENT_ID,
        documentId: document.id,
        requesterEntityId: REQUESTER_ID,
        requesterRoomIds: [ROOM_A],
        requesterRole: "ADMIN",
        expected,
        directGrantEntityIds: [],
      })
    ).resolves.toEqual({ status: "conflict" });
  });

  it("preserves document metadata and excludes mixed table types by room", async () => {
    const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), AGENT_ID);
    await adapter.initialize();
    await grantCurrentRoom(adapter, ROOM_A);
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
    await grantCurrentRoom(adapter, ROOM_A);
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
    await grantCurrentRoom(adapter, ROOM_A);
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

  it("rejects reused fragment ids without corrupting the committed vector", async () => {
    const storage = new MemoryStorage();
    const adapter = new InMemoryDatabaseAdapter(storage, AGENT_ID);
    await adapter.initialize();
    const original = memory(20, ROOM_A, { documentRevision: 0 });
    const oldEmbedding = [1, ...Array.from({ length: 383 }, () => 0)];
    const oldFragment = {
      ...memory(21, ROOM_A),
      content: { text: "old searchable fragment" },
      embedding: oldEmbedding,
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
    const reusedFragment = {
      ...oldFragment,
      content: { text: "new fragment with reused id" },
      embedding: [0, 1, ...Array.from({ length: 382 }, () => 0)],
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
        fragments: [reusedFragment],
      })
    ).rejects.toMatchObject({ code: "DOCUMENT_REVISION_FRAGMENT_ID_CONFLICT" });
    await expect(
      adapter.searchMemories({
        tableName: "document_fragments",
        embedding: oldEmbedding,
        match_threshold: 0.99,
        limit: 1,
      })
    ).resolves.toEqual([
      expect.objectContaining({
        id: oldFragment.id,
        content: { text: "old searchable fragment" },
      }),
    ]);
    await expect(adapter.getMemoriesByIds([original.id], "documents")).resolves.toEqual([
      expect.objectContaining({
        content: { text: original.content.text },
        metadata: expect.objectContaining({ documentRevision: 0 }),
      }),
    ]);
  });

  it("does not expose staged revision vectors before the storage swap", async () => {
    const storage = new BlockingBatchStorage();
    const adapter = new InMemoryDatabaseAdapter(storage, AGENT_ID);
    await adapter.initialize();
    // searchMemories ranks the eligible set exhaustively (#23405), so the read
    // barrier is observed through searchExact rather than the approximate walk.
    const vectorSearch = vi.spyOn(
      (
        adapter as unknown as {
          vectorIndex: {
            searchExact: (
              embedding: number[],
              limit: number,
              threshold: number,
              eligibleIds?: ReadonlySet<string>
            ) => Promise<unknown[]>;
          };
        }
      ).vectorIndex,
      "searchExact"
    );
    const original = memory(10, ROOM_A, { documentRevision: 0 });
    const oldFragment = {
      ...memory(11, ROOM_A),
      content: { text: "old searchable fragment" },
      embedding: [0, 1, ...Array.from({ length: 382 }, () => 0)],
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
      id: memory(12, ROOM_A).id,
      content: { text: "new searchable fragment" },
      embedding: [1, ...Array.from({ length: 383 }, () => 0)],
      metadata: { ...oldFragment.metadata, documentRevision: 1 },
    };

    const replacementPromise = adapter.replaceDocumentRevision({
      agentId: AGENT_ID,
      requesterEntityId: REQUESTER_ID,
      requesterRoomIds: [],
      requesterRole: "OWNER",
      documentId: original.id,
      expected,
      replacement,
      fragments: [newFragment],
    });
    await storage.batchStarted;
    const readPromise = adapter.searchMemories({
      tableName: "document_fragments",
      embedding: newFragment.embedding,
      match_threshold: 0.9,
      limit: 1,
    });
    expect(vectorSearch).not.toHaveBeenCalled();

    storage.release();
    await expect(replacementPromise).resolves.toMatchObject({ status: "updated" });
    await expect(readPromise).resolves.toEqual([
      expect.objectContaining({
        id: newFragment.id,
        content: { text: "new searchable fragment" },
      }),
    ]);
    expect(vectorSearch).toHaveBeenCalledOnce();
  });
});
