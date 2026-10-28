/**
 * Exercises character-document boot races and attempt-fenced pre-chunked ingestion.
 * Timing seams use a mock runtime; persistence and embedding failures use a real
 * AgentRuntime, model registry, and in-memory adapter.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Character, Memory, UUID } from "@elizaos/core";
import { AgentRuntime, ElizaError, MemoryType, ModelType } from "@elizaos/core";
import { createMockRuntime, MOCK_AGENT_ID } from "@elizaos/testing";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DocumentService } from "./service.ts";
import { generateContentBasedId } from "./utils.ts";

const DOCUMENTS_TABLE = "documents";
const DOCUMENT_FRAGMENTS_TABLE = "document_fragments";

function embeddingFor(text: string): number[] {
  return [text.length, 1, 0.5];
}

async function createRealRuntime(): Promise<AgentRuntime> {
  const adapter = SQLiteDatabaseAdapter.create(":memory:", MOCK_AGENT_ID);
  await adapter.initialize();
  await adapter.ensureEmbeddingDimension(embeddingFor("").length);
  return new AgentRuntime({
    agentId: MOCK_AGENT_ID,
    character: {
      name: "DocumentCharacterIngestTestAgent",
      bio: "Exercises character document persistence through the real runtime.",
      settings: {},
    } as Character,
    adapter,
    logLevel: "fatal",
  });
}

async function getStoredMemories(
  runtime: AgentRuntime,
  tableName: string,
): Promise<Memory[]> {
  return runtime.getMemories({
    tableName,
    agentId: MOCK_AGENT_ID,
    roomId: MOCK_AGENT_ID,
    count: 20,
  });
}

describe("DocumentService character document ingestion boot races", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("waits for delayed TEXT_EMBEDDING registration before ingesting character documents", async () => {
    vi.useFakeTimers();

    let embeddingRegistered = false;
    const created: Array<{ memory: Memory; table: string }> = [];

    const runtime = createMockRuntime({
      getSetting: () => undefined,
      redactSecrets: (text: string) => text,
      getModel: (type: string) =>
        type === ModelType.TEXT_EMBEDDING && embeddingRegistered
          ? async () => embeddingFor("registered")
          : undefined,
      getMemoryById: async () => null,
      getMemories: async () => [],
      createMemory: async (memory: Memory, table: string): Promise<UUID> => {
        created.push({ memory, table });
        return memory.id as UUID;
      },
      createMemories: async (entries) => {
        for (const { memory, tableName } of entries) {
          created.push({ memory, table: tableName });
        }
        return entries.map(({ memory }) => memory.id as UUID);
      },
      updateMemory: async () => true,
      deleteMemory: async () => {},
      addEmbeddingToMemory: async (memory: Memory) => {
        memory.embedding = embeddingFor(memory.content.text ?? "");
        return memory;
      },
    });
    const service = new DocumentService(runtime);

    setTimeout(() => {
      embeddingRegistered = true;
    }, 1_075);

    const processing = service.processCharacterDocuments(
      ["Character knowledge that should not ingest until embeddings exist."],
      { embeddingWaitTimeoutMs: 500, embeddingWaitIntervalMs: 25 },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(created).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(100);
    await processing;

    expect(created.some((entry) => entry.table === DOCUMENTS_TABLE)).toBe(true);
    expect(
      created.some((entry) => entry.table === DOCUMENT_FRAGMENTS_TABLE),
    ).toBe(true);
    expect(
      created
        .filter(
          (entry) =>
            entry.table === DOCUMENT_FRAGMENTS_TABLE &&
            entry.memory.metadata?.fragmentRole !== "source-segment",
        )
        .every((entry) => Array.isArray(entry.memory.embedding)),
    ).toBe(true);
  });

  test("reprocesses an existing content-id document stub when it has zero fragments", async () => {
    const runtime = await createRealRuntime();
    runtime.registerModel(
      ModelType.TEXT_EMBEDDING,
      async (_runtime, params: { text?: string }) =>
        embeddingFor(params.text ?? ""),
      "document-character-ingest-test",
      1_000,
    );
    const service = new DocumentService(runtime);
    const options = {
      agentId: MOCK_AGENT_ID,
      worldId: MOCK_AGENT_ID,
      roomId: MOCK_AGENT_ID,
      entityId: MOCK_AGENT_ID,
      content: "A document that previously booted into a zero-fragment stub.",
      contentType: "text/plain",
      originalFilename: "boot-race.txt",
    };
    const existingDocumentId = generateContentBasedId(
      options.content,
      MOCK_AGENT_ID,
      {
        includeFilename: options.originalFilename,
        contentType: options.contentType,
      },
    ) as UUID;
    await runtime.createMemory(
      {
        id: existingDocumentId,
        agentId: MOCK_AGENT_ID,
        roomId: MOCK_AGENT_ID,
        entityId: MOCK_AGENT_ID,
        content: { text: "stale stub" },
        metadata: { type: MemoryType.DOCUMENT, documentId: existingDocumentId },
      },
      DOCUMENTS_TABLE,
    );

    const result = await service.addDocument(options);

    expect(existingDocumentId).toBe(result.clientDocumentId);
    expect(result.fragmentCount).toBeGreaterThan(0);
    expect(
      (await runtime.getMemoryById(existingDocumentId))?.metadata,
    ).toMatchObject({ ingestionState: "ready" });
    expect(
      await getStoredMemories(runtime, DOCUMENT_FRAGMENTS_TABLE),
    ).not.toHaveLength(0);
  });

  test("claims a pre-chunked parent before batching all anchored fragments", async () => {
    const runtime = await createRealRuntime();
    const createMemories = vi.spyOn(runtime, "createMemories");
    const service = new DocumentService(runtime);

    const result = await service.addDocument({
      agentId: MOCK_AGENT_ID,
      worldId: MOCK_AGENT_ID,
      roomId: MOCK_AGENT_ID,
      entityId: MOCK_AGENT_ID,
      clientDocumentId: MOCK_AGENT_ID,
      contentType: "text/plain",
      originalFilename: "meeting.txt",
      content: "Alice: first\nBob: second",
      fragments: [
        {
          text: "Alice: first",
          metadata: { segmentIds: ["s1"], startMs: 0, endMs: 900 },
        },
        {
          text: "Bob: second",
          metadata: { segmentIds: ["s2"], startMs: 1000, endMs: 1800 },
        },
      ],
    });

    expect(result.fragmentCount).toBe(2);
    const batches = createMemories.mock.calls.flatMap(([entries]) => entries);
    expect(
      batches.filter(
        ({ memory }) => memory.metadata?.fragmentRole !== "source-segment",
      ),
    ).toHaveLength(2);
    expect(
      batches.some(
        ({ memory }) => memory.metadata?.fragmentRole === "source-segment",
      ),
    ).toBe(true);
    const documents = await getStoredMemories(runtime, DOCUMENTS_TABLE);
    const fragments = (
      await getStoredMemories(runtime, DOCUMENT_FRAGMENTS_TABLE)
    ).filter(
      (fragment) => fragment.metadata?.fragmentRole !== "source-segment",
    );
    expect(documents).toHaveLength(1);
    expect(fragments).toHaveLength(2);
    expect(
      fragments.every((fragment) => fragment.embedding === undefined),
    ).toBe(true);
    expect(fragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            segmentIds: ["s1"],
            startMs: 0,
            endMs: 900,
            position: 0,
          }),
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({
            segmentIds: ["s2"],
            startMs: 1000,
            endMs: 1800,
            position: 1,
          }),
        }),
      ]),
    );
  });

  test("does not write the parent when any pre-chunked embedding fails", async () => {
    const documentId = generateContentBasedId("first\nsecond", MOCK_AGENT_ID, {
      includeFilename: "meeting.txt",
      contentType: "text/plain",
    });
    let embeddings = 0;
    const runtime = await createRealRuntime();
    runtime.registerModel(
      ModelType.TEXT_EMBEDDING,
      async (_runtime, params) => {
        const text = params.text;
        if (typeof text !== "string") {
          throw new Error("embedding input must contain text");
        }
        embeddings++;
        return embeddings === 1 ? embeddingFor(text) : [];
      },
      "document-character-ingest-test",
      100,
    );
    const service = new DocumentService(runtime);

    let thrown: unknown;
    try {
      await service.addDocument({
        agentId: MOCK_AGENT_ID,
        worldId: MOCK_AGENT_ID,
        roomId: MOCK_AGENT_ID,
        entityId: MOCK_AGENT_ID,
        clientDocumentId: MOCK_AGENT_ID,
        contentType: "text/plain",
        originalFilename: "meeting.txt",
        content: "first\nsecond",
        fragments: [
          {
            text: "first",
            metadata: { segmentIds: ["s1"], startMs: 0, endMs: 500 },
          },
          {
            text: "second",
            metadata: { segmentIds: ["s2"], startMs: 600, endMs: 1000 },
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }

    if (!(thrown instanceof ElizaError)) {
      throw new Error("Expected document ingestion to throw ElizaError", {
        cause: thrown,
      });
    }
    expect(thrown.code).toBe("DOCUMENT_PROCESSING_FAILED");
    expect(thrown.cause).toBeInstanceOf(ElizaError);
    if (!(thrown.cause instanceof ElizaError)) {
      throw new Error(
        "Expected document failure to preserve its fragment cause",
      );
    }
    expect(thrown.cause).toMatchObject({
      code: "DOCUMENT_FRAGMENT_EMBED_FAILED",
      context: { documentId, position: 1 },
    });
    expect(thrown.cause.cause).toBeInstanceOf(ElizaError);
    if (!(thrown.cause.cause instanceof ElizaError)) {
      throw new Error("Expected fragment failure to preserve provider cause");
    }
    expect(thrown.cause.cause).toMatchObject({
      code: "EMBEDDING_MODEL_OUTPUT_INVALID",
      context: { outputKind: "empty-array" },
    });
    expect(embeddings).toBe(2);
    await expect(getStoredMemories(runtime, DOCUMENTS_TABLE)).resolves.toEqual(
      [],
    );
    await expect(
      getStoredMemories(runtime, DOCUMENT_FRAGMENTS_TABLE),
    ).resolves.toEqual([]);
  });

  test("refuses pre-chunked persistence when dimension probing disabled embedding generation", async () => {
    const documentId = generateContentBasedId("first", MOCK_AGENT_ID, {
      includeFilename: "disabled-embedding.txt",
      contentType: "text/plain",
    });
    const runtime = await createRealRuntime();
    runtime.registerModel(
      ModelType.TEXT_EMBEDDING,
      async () => [],
      "document-character-disabled-embedding-test",
      100,
    );
    await expect(runtime.ensureEmbeddingDimension()).rejects.toThrow();
    expect(runtime.isEmbeddingGenerationDisabled()).toBe(true);
    const service = new DocumentService(runtime);

    let thrown: unknown;
    try {
      await service.addDocument({
        agentId: MOCK_AGENT_ID,
        worldId: MOCK_AGENT_ID,
        roomId: MOCK_AGENT_ID,
        entityId: MOCK_AGENT_ID,
        clientDocumentId: MOCK_AGENT_ID,
        contentType: "text/plain",
        originalFilename: "disabled-embedding.txt",
        content: "first",
        fragments: [
          {
            text: "first",
            metadata: { segmentIds: ["s1"], startMs: 0, endMs: 500 },
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ElizaError);
    if (!(thrown instanceof ElizaError)) {
      throw new Error("Expected disabled embedding ingestion to fail");
    }
    expect(thrown.code).toBe("DOCUMENT_PROCESSING_FAILED");
    expect(thrown.cause).toMatchObject({
      code: "DOCUMENT_FRAGMENT_EMBED_FAILED",
      context: { documentId, position: 0 },
    });
    await expect(getStoredMemories(runtime, DOCUMENTS_TABLE)).resolves.toEqual(
      [],
    );
    await expect(
      getStoredMemories(runtime, DOCUMENT_FRAGMENTS_TABLE),
    ).resolves.toEqual([]);
  });
});

describe("DocumentService character document changes", () => {
  test("drops the old document when a character's knowledge text changes", async () => {
    const runtime = await createRealRuntime();
    runtime.registerModel(
      ModelType.TEXT_EMBEDDING,
      async (_runtime, params: { text?: string }) =>
        embeddingFor(params.text ?? ""),
      "document-character-ingest-test",
      1_000,
    );

    await new DocumentService(runtime).processCharacterDocuments([
      "Our office is at 1 Main St.",
    ]);
    // The character is edited and the agent boots again.
    await new DocumentService(runtime).processCharacterDocuments([
      "Our office is at 2 Oak Ave.",
    ]);

    const documents = await getStoredMemories(runtime, DOCUMENTS_TABLE);
    expect(documents.map((document) => document.content.text)).toEqual([
      "Our office is at 2 Oak Ave.",
    ]);
    const fragments = await getStoredMemories(
      runtime,
      DOCUMENT_FRAGMENTS_TABLE,
    );
    expect(
      fragments.some((fragment) =>
        fragment.content.text?.includes("1 Main St"),
      ),
    ).toBe(false);
  }, 30_000);

  async function createEmbeddingRuntime(): Promise<AgentRuntime> {
    const runtime = await createRealRuntime();
    runtime.registerModel(
      ModelType.TEXT_EMBEDDING,
      async (_runtime, params: { text?: string }) =>
        embeddingFor(params.text ?? ""),
      "document-character-ingest-test",
      1_000,
    );
    return runtime;
  }

  function storedTexts(documents: Memory[]): Array<string | undefined> {
    return documents.map((document) => document.content.text).sort();
  }

  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "character-documents-"));
    tempDirs.push(dir);
    return dir;
  }

  test("keeps a file document when its declared path is missing at boot", async () => {
    const runtime = await createEmbeddingRuntime();
    const filePath = join(makeTempDir(), "handbook.md");
    writeFileSync(filePath, "The handbook says lunch is at noon.");

    await new DocumentService(runtime).processCharacterDocuments([
      { path: filePath },
      "Inline character fact.",
    ]);
    const before = await getStoredMemories(runtime, DOCUMENTS_TABLE);
    expect(before).toHaveLength(2);

    rmSync(filePath);
    await new DocumentService(runtime).processCharacterDocuments([
      { path: filePath },
      "Inline character fact.",
    ]);

    const after = await getStoredMemories(runtime, DOCUMENTS_TABLE);
    expect(after.map((document) => document.id).sort()).toEqual(
      before.map((document) => document.id).sort(),
    );
    expect(storedTexts(after)).not.toContain(filePath);
  }, 30_000);

  test("keeps directory documents when the folder is missing or empty at boot", async () => {
    const runtime = await createEmbeddingRuntime();
    const directory = join(makeTempDir(), "knowledge");
    mkdirSync(directory);
    writeFileSync(join(directory, "a.txt"), "Folder fact one.");
    writeFileSync(join(directory, "b.txt"), "Folder fact two.");

    await new DocumentService(runtime).processCharacterDocuments([
      { path: directory },
    ]);
    const before = await getStoredMemories(runtime, DOCUMENTS_TABLE);
    expect(before).toHaveLength(2);

    // The folder is briefly empty (e.g. a volume not mounted yet).
    rmSync(join(directory, "a.txt"));
    rmSync(join(directory, "b.txt"));
    await new DocumentService(runtime).processCharacterDocuments([
      { path: directory },
    ]);
    expect(
      (await getStoredMemories(runtime, DOCUMENTS_TABLE))
        .map((document) => document.id)
        .sort(),
    ).toEqual(before.map((document) => document.id).sort());

    // The folder is missing entirely.
    rmSync(directory, { recursive: true, force: true });
    await new DocumentService(runtime).processCharacterDocuments([
      { path: directory },
    ]);
    const after = await getStoredMemories(runtime, DOCUMENTS_TABLE);
    expect(after.map((document) => document.id).sort()).toEqual(
      before.map((document) => document.id).sort(),
    );
    expect(storedTexts(after)).not.toContain(directory);
  }, 30_000);

  test("treats a missing path-like plain string as a failed load, not inline text", async () => {
    const runtime = await createEmbeddingRuntime();
    const directory = join(makeTempDir(), "docs");
    mkdirSync(directory);
    writeFileSync(join(directory, "a.txt"), "Plain-string folder fact.");

    await new DocumentService(runtime).processCharacterDocuments([directory]);
    const before = await getStoredMemories(runtime, DOCUMENTS_TABLE);
    expect(before).toHaveLength(1);

    rmSync(directory, { recursive: true, force: true });
    await new DocumentService(runtime).processCharacterDocuments([directory]);

    const after = await getStoredMemories(runtime, DOCUMENTS_TABLE);
    expect(after.map((document) => document.id)).toEqual(
      before.map((document) => document.id),
    );
    expect(storedTexts(after)).not.toContain(directory);
  }, 30_000);
});
