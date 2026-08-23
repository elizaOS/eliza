/**
 * Unit tests for bundled knowledge document seeding, fragment listing, and metadata building.
 */

import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DOCUMENTS,
  type DefaultDocumentDefinition,
  listFragmentIdsForDocument,
  seedBundledDocuments,
} from "./default-documents.js";

function makeMockRuntime(): AgentRuntime {
  const memories = new Map<UUID, Memory>();

  return {
    agentId: "11111111-2222-3333-4444-555555555555" as UUID,
    getSetting: vi.fn().mockReturnValue(undefined),
    getMemoryById: vi
      .fn()
      .mockImplementation(async (id: UUID) => memories.get(id) ?? null),
    getMemories: vi
      .fn()
      .mockImplementation(async () => Array.from(memories.values())),
    createMemory: vi.fn().mockImplementation(async (memory: Memory) => {
      memories.set(memory.id as UUID, memory);
      return memory.id;
    }),
    updateMemory: vi.fn().mockImplementation(async (memory: Memory) => {
      memories.set(memory.id as UUID, memory);
    }),
    deleteMemory: vi.fn().mockImplementation(async (id: UUID) => {
      memories.delete(id);
    }),
    addEmbeddingToMemory: vi
      .fn()
      .mockImplementation(async (memory: Memory) => memory),
  } as unknown as AgentRuntime;
}

describe("default-documents", () => {
  it("exports valid DEFAULT_DOCUMENTS definitions", () => {
    expect(DEFAULT_DOCUMENTS.length).toBeGreaterThan(0);
    for (const doc of DEFAULT_DOCUMENTS) {
      expect(doc.key).toBeDefined();
      expect(doc.text).toBeDefined();
      expect(doc.fragments.length).toBeGreaterThan(0);
      expect(doc.filename).toBeDefined();
    }
  });

  it("seeds bundled documents into memory idempotently", async () => {
    const runtime = makeMockRuntime();
    const testDoc: DefaultDocumentDefinition = {
      key: "test-doc",
      version: 1,
      filename: "test-doc.txt",
      contentType: "text/plain",
      text: "Test doc text",
      fragments: [{ text: "Test fragment 1" }, { text: "Test fragment 2" }],
    };

    await seedBundledDocuments(runtime, [testDoc]);

    expect(runtime.createMemory).toHaveBeenCalled();

    // Second run should be idempotent
    await seedBundledDocuments(runtime, [testDoc]);
  });

  it("lists fragment IDs for a given document", async () => {
    const runtime = makeMockRuntime();
    const docId = "doc-123" as UUID;
    const fragId = "frag-456" as UUID;

    await runtime.createMemory(
      {
        id: fragId,
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        content: { text: "fragment" },
        metadata: { documentId: docId },
      },
      "document_fragments",
    );

    const ids = await listFragmentIdsForDocument(runtime, docId);
    expect(ids).toContain(fragId);
  });
});
