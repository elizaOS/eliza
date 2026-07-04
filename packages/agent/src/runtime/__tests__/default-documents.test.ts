/**
 * Unit coverage for listFragmentIdsForDocument: it must exclude embeddings from
 * every fragment lookup and paginate by row offset (not the createdAt `start`
 * filter), collecting only ids that belong to the requested document. Drives a
 * deterministic in-memory runtime stub whose getMemories serves paged
 * fragments — no SQL adapter.
 */
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { listFragmentIdsForDocument } from "../default-documents.ts";

const AGENT_ID = "00000000-0000-0000-0000-00000000a9e1" as UUID;
const DOCUMENT_ID = "00000000-0000-0000-0000-0000000d0c01" as UUID;
const OTHER_DOCUMENT_ID = "00000000-0000-0000-0000-0000000d0c02" as UUID;

function fragmentMemory(index: number, documentId: UUID): Memory {
  const suffix = index.toString(16).padStart(12, "0");
  return {
    id: `00000000-0000-0000-0000-${suffix}` as UUID,
    agentId: AGENT_ID,
    roomId: AGENT_ID,
    entityId: AGENT_ID,
    content: { text: `fragment ${index}` },
    metadata: {
      type: "fragment",
      documentId,
      position: index,
    },
  } as Memory;
}

/**
 * Build a runtime stub whose getMemories serves `total` fragments in
 * offset/limit pages, mirroring the SQL adapters' pagination contract.
 */
function makeRuntime(total: number, documentId: UUID) {
  const rows = Array.from({ length: total }, (_, i) =>
    fragmentMemory(i, documentId),
  );
  const getMemories = vi.fn(
    async (params: {
      limit?: number;
      offset?: number;
      includeEmbedding?: boolean;
      start?: number;
    }) => {
      const offset = params.offset ?? 0;
      const limit = params.limit ?? rows.length;
      return rows.slice(offset, offset + limit);
    },
  );
  const runtime = { agentId: AGENT_ID, getMemories } as unknown as AgentRuntime;
  return { runtime, getMemories };
}

describe("listFragmentIdsForDocument", () => {
  it("excludes embeddings from every fragment lookup", async () => {
    // Regression: omitting includeEmbedding made plugin-sql select and
    // deserialize every pgvector embedding at boot, pegging the main thread
    // on self-hosted PGlite nodes even though only ids/metadata are used.
    const { runtime, getMemories } = makeRuntime(3, DOCUMENT_ID);

    await listFragmentIdsForDocument(runtime, DOCUMENT_ID);

    expect(getMemories).toHaveBeenCalled();
    for (const [params] of getMemories.mock.calls) {
      expect(params.includeEmbedding).toBe(false);
    }
  });

  it("paginates with offset (not the start timestamp filter) and collects all ids", async () => {
    // Regression: passing the row offset as `start` (a createdAt filter)
    // re-scanned nearly the whole table each loop and never made progress
    // for documents with more than one batch of fragments.
    const total = 250; // 3 pages at DOCUMENT_BATCH_SIZE=100
    const { runtime, getMemories } = makeRuntime(total, DOCUMENT_ID);

    const ids = await listFragmentIdsForDocument(runtime, DOCUMENT_ID);

    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);

    expect(getMemories).toHaveBeenCalledTimes(3);
    const offsets = getMemories.mock.calls.map(([params]) => params.offset);
    expect(offsets).toEqual([0, 100, 200]);
    for (const [params] of getMemories.mock.calls) {
      expect(params).not.toHaveProperty("start");
    }
  });

  it("only returns ids belonging to the requested document", async () => {
    const { runtime } = makeRuntime(5, OTHER_DOCUMENT_ID);

    const ids = await listFragmentIdsForDocument(runtime, DOCUMENT_ID);

    expect(ids).toEqual([]);
  });
});
