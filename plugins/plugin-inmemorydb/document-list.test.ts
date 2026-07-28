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
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const AGENT_ID = "50000000-0000-0000-0000-000000000001" as UUID;
const REQUESTER_ID = "50000000-0000-0000-0000-000000000002" as UUID;
const ROOM_A = "50000000-0000-0000-0000-000000000003" as UUID;
const ROOM_B = "50000000-0000-0000-0000-000000000004" as UUID;

function memory(index: number, roomId: UUID, metadata: Record<string, unknown> = {}): Memory {
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
});
