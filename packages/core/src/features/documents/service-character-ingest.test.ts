/**
 * Unit tests for `DocumentService` character-document ingestion under boot races:
 * it waits for a late `TEXT_EMBEDDING` registration before ingesting (rather than
 * writing empty-fragment stubs), and reprocesses an existing zero-fragment
 * document stub. Drives `createMockRuntime` with Vitest fake timers —
 * deterministic, no live model or DB.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMockRuntime, MOCK_AGENT_ID } from "../../testing/mock-runtime";
import type { Memory, UUID } from "../../types";
import { MemoryType, ModelType } from "../../types";
import { DocumentService } from "./service.ts";

const DOCUMENTS_TABLE = "documents";
const DOCUMENT_FRAGMENTS_TABLE = "document_fragments";

function embeddingFor(text: string): number[] {
	return [text.length, 1, 0.5];
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
				.filter((entry) => entry.table === DOCUMENT_FRAGMENTS_TABLE)
				.every((entry) => Array.isArray(entry.memory.embedding)),
		).toBe(true);
	});

	test("reprocesses an existing content-id document stub when it has zero fragments", async () => {
		const created: Array<{ memory: Memory; table: string }> = [];
		const deleted: UUID[] = [];
		let existingDocumentId: UUID | null = null;

		const runtime = createMockRuntime({
			getSetting: () => undefined,
			redactSecrets: (text: string) => text,
			getModel: (type: string) =>
				type === ModelType.TEXT_EMBEDDING
					? async () => embeddingFor("registered")
					: undefined,
			getMemoryById: async (id: UUID) => {
				if (existingDocumentId === null) {
					existingDocumentId = id;
				}
				if (id !== existingDocumentId || deleted.includes(id)) {
					return null;
				}
				return {
					id,
					agentId: MOCK_AGENT_ID,
					content: { text: "stale stub" },
					metadata: { type: MemoryType.DOCUMENT, documentId: id },
				} as Memory;
			},
			getMemories: async ({ tableName }) =>
				tableName === DOCUMENT_FRAGMENTS_TABLE ? [] : [],
			deleteMemory: async (id: UUID) => {
				deleted.push(id);
			},
			createMemory: async (memory: Memory, table: string): Promise<UUID> => {
				created.push({ memory, table });
				return memory.id as UUID;
			},
			updateMemory: async () => true,
			useModel: async (type: string, params: { text?: string }) => {
				if (type !== ModelType.TEXT_EMBEDDING) {
					throw new Error(`unexpected model ${type}`);
				}
				return embeddingFor(params.text ?? "");
			},
		});
		const service = new DocumentService(runtime);

		const result = await service.addDocument({
			agentId: MOCK_AGENT_ID,
			worldId: MOCK_AGENT_ID,
			roomId: MOCK_AGENT_ID,
			entityId: MOCK_AGENT_ID,
			content: "A document that previously booted into a zero-fragment stub.",
			contentType: "text/plain",
			originalFilename: "boot-race.txt",
		});

		expect(existingDocumentId).toBe(result.clientDocumentId);
		expect(deleted).toEqual([result.clientDocumentId]);
		expect(result.fragmentCount).toBeGreaterThan(0);
		expect(created.some((entry) => entry.table === DOCUMENTS_TABLE)).toBe(true);
		expect(
			created.some((entry) => entry.table === DOCUMENT_FRAGMENTS_TABLE),
		).toBe(true);
	});

	test("persists a pre-chunked parent and all anchored fragments in one batch", async () => {
		const batches: Array<
			Array<{ memory: Memory; tableName: string; unique?: boolean }>
		> = [];
		const runtime = createMockRuntime({
			getSetting: () => undefined,
			redactSecrets: (text: string) => text,
			getMemoryById: async () => null,
			addEmbeddingToMemory: async (memory: Memory) => {
				memory.embedding = embeddingFor(memory.content.text ?? "");
				return memory;
			},
			createMemory: vi.fn(async () => {
				throw new Error("single-row persistence must not run");
			}),
			createMemories: async (entries) => {
				batches.push(entries);
				return entries.map((entry) => entry.memory.id as UUID);
			},
		});
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
		expect(batches).toHaveLength(1);
		expect(batches[0].map((entry) => entry.tableName)).toEqual([
			DOCUMENTS_TABLE,
			DOCUMENT_FRAGMENTS_TABLE,
			DOCUMENT_FRAGMENTS_TABLE,
		]);
		expect(batches[0][1].memory.metadata).toMatchObject({
			segmentIds: ["s1"],
			startMs: 0,
			endMs: 900,
			position: 0,
		});
	});

	test("does not write the parent when any pre-chunked embedding fails", async () => {
		const createMemories = vi.fn();
		let embeddings = 0;
		const runtime = createMockRuntime({
			getSetting: () => undefined,
			redactSecrets: (text: string) => text,
			getMemoryById: async () => null,
			addEmbeddingToMemory: async (memory: Memory) => {
				embeddings++;
				if (embeddings === 1) memory.embedding = embeddingFor("first");
				return memory;
			},
			createMemories,
		});
		const service = new DocumentService(runtime);

		await expect(
			service.addDocument({
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
			}),
		).rejects.toThrow(/Failed to process document/);
		expect(createMemories).not.toHaveBeenCalled();
	});
});
