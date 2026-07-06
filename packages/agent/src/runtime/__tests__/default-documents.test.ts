/**
 * Unit coverage for the bundled-document seeding path: fragment-id listing
 * (embedding exclusion + offset pagination), the shape of the bundled help
 * documents, and seedBundledDocuments' create/idempotent-re-run/version-bump/
 * stale-fragment-prune behavior. Drives a deterministic in-memory runtime
 * stub — no SQL adapter, no model calls.
 */
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DOCUMENTS,
  type DefaultDocumentDefinition,
  listFragmentIdsForDocument,
  seedBundledDocuments,
} from "../default-documents.ts";
import {
  HELP_DOCUMENTS,
  HELP_KNOWLEDGE_TAG,
} from "../default-help-documents.ts";

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

// ── Seeding behavior (in-memory runtime) ────────────────────────────────────

interface SeedHarness {
  runtime: AgentRuntime;
  memories: Map<string, Memory>;
  createMemory: ReturnType<typeof vi.fn>;
  updateMemory: ReturnType<typeof vi.fn>;
  deleteMemory: ReturnType<typeof vi.fn>;
}

/**
 * Minimal in-memory implementation of the runtime surface the seeder touches:
 * a single id-keyed memory map backing getMemoryById/create/update/delete and
 * a paged getMemories over the fragment rows.
 */
function makeSeedHarness(): SeedHarness {
  const memories = new Map<string, Memory>();
  const fragmentRows = () =>
    [...memories.values()].filter(
      (m) =>
        (m.metadata as Record<string, unknown> | undefined)?.type ===
        "fragment",
    );
  const createMemory = vi.fn(async (memory: Memory, _table: string) => {
    memories.set(memory.id as string, memory);
    return memory.id as UUID;
  });
  const updateMemory = vi.fn(async (memory: Memory) => {
    memories.set(memory.id as string, memory);
    return true;
  });
  const deleteMemory = vi.fn(async (id: UUID) => {
    memories.delete(id);
  });
  const runtime = {
    agentId: AGENT_ID,
    getSetting: () => undefined,
    getMemoryById: async (id: UUID) => memories.get(id) ?? null,
    createMemory,
    updateMemory,
    deleteMemory,
    addEmbeddingToMemory: async (memory: Memory) => memory,
    getMemories: async (params: { limit?: number; offset?: number }) => {
      const rows = fragmentRows();
      const offset = params.offset ?? 0;
      const limit = params.limit ?? rows.length;
      return rows.slice(offset, offset + limit);
    },
  } as unknown as AgentRuntime;
  return { runtime, memories, createMemory, updateMemory, deleteMemory };
}

describe("bundled help documents", () => {
  it("ships one document per help topic with one Q&A fragment per entry", () => {
    expect(HELP_DOCUMENTS.length).toBe(9);
    for (const doc of HELP_DOCUMENTS) {
      expect(doc.key).toMatch(/^eliza-help-[a-z-]+$/);
      expect(doc.version).toBeGreaterThanOrEqual(1);
      expect(doc.contentType).toBe("text/plain");
      expect(doc.fragments.length).toBeGreaterThan(0);
      for (const fragment of doc.fragments) {
        expect(fragment.text).toMatch(/^Q: .+\nA: .+/s);
        // Every fragment is contained in the document text, so whole-document
        // retrieval and fragment retrieval agree.
        expect(doc.text).toContain(fragment.text);
      }
    }
  });

  it("keeps DEFAULT_DOCUMENTS keys unique and includes the help set", () => {
    const keys = DEFAULT_DOCUMENTS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const doc of HELP_DOCUMENTS) {
      expect(keys).toContain(doc.key);
    }
  });

  it("stays durable: no screen-relative or widget-relative instructions", () => {
    for (const doc of HELP_DOCUMENTS) {
      expect(doc.text).not.toMatch(
        /below|tap “|deepLink|start the tutorial|tutorial (tile|launcher)|launcher tile/i,
      );
    }
  });
});

describe("seedBundledDocuments", () => {
  it("creates one document row and one row per fragment", async () => {
    const harness = makeSeedHarness();
    const docs = HELP_DOCUMENTS.slice(0, 2);
    await seedBundledDocuments(harness.runtime, docs);

    const expectedRows = docs.reduce(
      (sum, doc) => sum + 1 + doc.fragments.length,
      0,
    );
    expect(harness.memories.size).toBe(expectedRows);
    expect(harness.createMemory).toHaveBeenCalledTimes(expectedRows);
    for (const doc of docs) {
      const documentRow = [...harness.memories.values()].find(
        (m) =>
          (m.metadata as Record<string, unknown>).bundledDocumentKey ===
            doc.key &&
          (m.metadata as Record<string, unknown>).type === "document",
      );
      expect(documentRow?.content.text).toBe(doc.text);
    }
  });

  it("copies searchable document metadata onto seeded fragments", async () => {
    const harness = makeSeedHarness();
    const [helpDocument] = HELP_DOCUMENTS;

    await seedBundledDocuments(harness.runtime, [helpDocument]);

    const fragmentRow = [...harness.memories.values()].find(
      (m) =>
        (m.metadata as Record<string, unknown>).bundledDocumentKey ===
          helpDocument.key &&
        (m.metadata as Record<string, unknown>).type === "fragment",
    );
    expect(fragmentRow?.metadata).toMatchObject({
      type: "fragment",
      tags: [HELP_KNOWLEDGE_TAG],
      helpCategory: helpDocument.metadata?.helpCategory,
    });
  });

  it("re-runs idempotently: no creates, updates, or deletes the second time", async () => {
    const harness = makeSeedHarness();
    const docs = HELP_DOCUMENTS.slice(0, 2);
    await seedBundledDocuments(harness.runtime, docs);
    harness.createMemory.mockClear();
    harness.updateMemory.mockClear();
    harness.deleteMemory.mockClear();

    await seedBundledDocuments(harness.runtime, docs);

    expect(harness.createMemory).not.toHaveBeenCalled();
    expect(harness.updateMemory).not.toHaveBeenCalled();
    expect(harness.deleteMemory).not.toHaveBeenCalled();
  });

  it("a version bump updates rows in place and prunes dropped fragments", async () => {
    const harness = makeSeedHarness();
    const base = HELP_DOCUMENTS[0];
    await seedBundledDocuments(harness.runtime, [base]);
    const rowsBefore = harness.memories.size;
    expect(base.fragments.length).toBeGreaterThan(1);

    // v2 rewrites the copy down to a single fragment: the document + surviving
    // fragment update in place, and every dropped fragment row is deleted.
    const bumped: DefaultDocumentDefinition = {
      ...base,
      version: base.version + 1,
      text: "Rewritten help topic.",
      fragments: [{ text: "Q: Rewritten?\nA: Yes." }],
    };
    harness.createMemory.mockClear();
    await seedBundledDocuments(harness.runtime, [bumped]);

    expect(harness.createMemory).not.toHaveBeenCalled();
    expect(harness.updateMemory).toHaveBeenCalled();
    expect(harness.deleteMemory).toHaveBeenCalledTimes(
      base.fragments.length - 1,
    );
    expect(harness.memories.size).toBe(
      rowsBefore - (base.fragments.length - 1),
    );
    const documentRow = [...harness.memories.values()].find(
      (m) => (m.metadata as Record<string, unknown>).type === "document",
    );
    expect(documentRow?.content.text).toBe("Rewritten help topic.");
    expect(
      (documentRow?.metadata as Record<string, unknown>).bundledDocumentVersion,
    ).toBe(base.version + 1);
  });
});
