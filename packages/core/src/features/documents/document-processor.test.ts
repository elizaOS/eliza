/**
 * Unit coverage for the document processor's public ingestion, extraction,
 * parent-memory, and producer-owned fragment contracts using the real module
 * with a typed runtime boundary harness.
 */
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { ElizaError } from "../../errors";
import { createMockRuntime, MOCK_AGENT_ID } from "../../testing/mock-runtime";
import type { IAgentRuntime, Memory, UUID } from "../../types";
import { MemoryType, ModelType } from "../../types";
import {
	createDocumentMemory,
	extractTextFromDocument,
	hasDocumentEmbeddingModel,
	preparePreChunkedFragmentMemories,
	processFragmentsSynchronously,
} from "./document-processor.ts";

const DOCUMENT_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const CLIENT_DOCUMENT_ID = "22222222-2222-2222-2222-222222222222" as UUID;
const ROOM_ID = "33333333-3333-3333-3333-333333333333" as UUID;
const ENTITY_ID = "44444444-4444-4444-4444-444444444444" as UUID;
const WORLD_ID = "55555555-5555-5555-5555-555555555555" as UUID;

function runtimeWith(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
	return createMockRuntime({
		getSetting: () => null,
		getModel: () => undefined,
		redactSecrets: (text: string) => text.replace("secret", "[redacted]"),
		...overrides,
	});
}

function preChunkArgs(
	runtime: IAgentRuntime,
	fragments: Array<{ text: string; metadata?: Record<string, unknown> }>,
) {
	return {
		runtime,
		documentId: DOCUMENT_ID,
		fragments,
		agentId: MOCK_AGENT_ID,
		roomId: ROOM_ID,
		entityId: ENTITY_ID,
		worldId: WORLD_ID,
		documentTitle: "Meeting",
	};
}

async function expectElizaCode(
	operation: Promise<unknown>,
	code: string,
): Promise<ElizaError> {
	try {
		await operation;
		throw new Error(`Expected ${code}`);
	} catch (error) {
		expect(error).toBeInstanceOf(ElizaError);
		expect((error as ElizaError).code).toBe(code);
		return error as ElizaError;
	}
}

describe("hasDocumentEmbeddingModel", () => {
	it("detects either individual or batch embedding registrations", () => {
		expect(hasDocumentEmbeddingModel(runtimeWith())).toBe(false);
		expect(
			hasDocumentEmbeddingModel(
				runtimeWith({
					getModel: (type: string) =>
						type === ModelType.TEXT_EMBEDDING ? async () => [1] : undefined,
				}),
			),
		).toBe(true);
		expect(
			hasDocumentEmbeddingModel(
				runtimeWith({
					getModel: (type: string) =>
						type === ModelType.TEXT_EMBEDDING_BATCH
							? async () => [[1]]
							: undefined,
				}),
			),
		).toBe(true);
	});
});

describe("processFragmentsSynchronously", () => {
	it.each(["", " \n\t "])("does not persist empty text %#", async (text) => {
		let writes = 0;
		const runtime = runtimeWith({
			createMemory: async (memory: Memory) => {
				writes += 1;
				return memory.id as UUID;
			},
		});

		const saved = await processFragmentsSynchronously({
			runtime,
			documentId: DOCUMENT_ID,
			fullDocumentText: text,
			agentId: MOCK_AGENT_ID,
		});

		expect(saved).toBe(0);
		expect(writes).toBe(0);
	});

	it("persists a redacted keyword fragment with explicit scope and metadata", async () => {
		const writes: Memory[] = [];
		const runtime = runtimeWith({
			createMemory: async (memory: Memory) => {
				writes.push(memory);
				return memory.id as UUID;
			},
		});

		const saved = await processFragmentsSynchronously({
			runtime,
			documentId: DOCUMENT_ID,
			fullDocumentText: "a secret note",
			agentId: MOCK_AGENT_ID,
			roomId: ROOM_ID,
			entityId: ENTITY_ID,
			worldId: WORLD_ID,
			documentTitle: "Private note",
			documentMetadata: { source: "character", custom: 7 },
		});

		expect(saved).toBe(1);
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({
			agentId: MOCK_AGENT_ID,
			roomId: ROOM_ID,
			entityId: ENTITY_ID,
			worldId: WORLD_ID,
			content: { text: "a [redacted] note" },
			metadata: {
				type: MemoryType.FRAGMENT,
				documentId: DOCUMENT_ID,
				position: 0,
				source: "character",
				documentTitle: "Private note",
				custom: 7,
			},
		});
	});

	it("returns the exact persisted count and reports a failed keyword write", async () => {
		const reports: Array<{ scope: string; context?: Record<string, unknown> }> =
			[];
		const runtime = runtimeWith({
			createMemory: async () => {
				throw new Error("database unavailable");
			},
			reportError: (scope, _error, context) => {
				reports.push({ scope, context });
			},
		});

		const saved = await processFragmentsSynchronously({
			runtime,
			documentId: DOCUMENT_ID,
			fullDocumentText: "one fragment",
			agentId: MOCK_AGENT_ID,
		});

		expect(saved).toBe(0);
		expect(reports).toEqual([
			{
				scope: "DocumentProcessor.persistKeywordFragment",
				context: { documentId: DOCUMENT_ID, position: 0 },
			},
		]);
	});

	it("generates and stores a real vector result when an embedding model exists", async () => {
		const writes: Memory[] = [];
		const runtime = runtimeWith({
			getSetting: (key: string) =>
				key === "RATE_LIMIT_ENABLED" ? "false" : null,
			getModel: (type: string) =>
				type === ModelType.TEXT_EMBEDDING
					? async () => [0.25, 0.75]
					: undefined,
			useModel: (async (type: string) => {
				if (type === ModelType.TEXT_EMBEDDING) return [0.25, 0.75];
				throw new Error(`Unexpected model: ${type}`);
			}) as IAgentRuntime["useModel"],
			createMemory: async (memory: Memory) => {
				writes.push(memory);
				return memory.id as UUID;
			},
		});

		const saved = await processFragmentsSynchronously({
			runtime,
			documentId: DOCUMENT_ID,
			fullDocumentText: "vector searchable text",
			agentId: MOCK_AGENT_ID,
		});

		expect(saved).toBe(1);
		expect(writes[0]?.embedding).toEqual([0.25, 0.75]);
		expect(writes[0]?.metadata).toMatchObject({
			type: MemoryType.FRAGMENT,
			documentId: DOCUMENT_ID,
			position: 0,
			source: "upload",
		});
	});
});

describe("extractTextFromDocument", () => {
	it("rejects an empty buffer before selecting a parser", async () => {
		await expect(
			extractTextFromDocument(Buffer.alloc(0), "text/plain", "empty.txt"),
		).rejects.toThrow("Empty file buffer provided for empty.txt");
	});

	it.each(["text/plain", "application/json", "application/xml"])(
		"decodes %s content directly as UTF-8",
		async (contentType) => {
			await expect(
				extractTextFromDocument(
					Buffer.from("héllo", "utf8"),
					contentType,
					"input.data",
				),
			).resolves.toBe("héllo");
		},
	);

	it("uses the safe plain-text fallback for an unknown non-binary type", async () => {
		await expect(
			extractTextFromDocument(
				Buffer.from("fallback text"),
				"application/x-custom",
				"input.custom",
			),
		).resolves.toBe("fallback text");
	});

	it("propagates a delegated parser rejection with its filename context", async () => {
		await expect(
			extractTextFromDocument(
				Buffer.from([0, 1, 2]),
				"application/octet-stream",
				"payload.bin",
			),
		).rejects.toThrow(
			"File payload.bin appears to be binary based on initial byte check",
		);
	});
});

describe("createDocumentMemory", () => {
	it("derives the parent identity, filename fields, and default upload metadata", () => {
		const memory = createDocumentMemory({
			text: "document body",
			agentId: MOCK_AGENT_ID,
			clientDocumentId: CLIENT_DOCUMENT_ID,
			originalFilename: "Quarterly.Report.PDF",
			contentType: "application/pdf",
			worldId: WORLD_ID,
			fileSize: 42,
			documentId: DOCUMENT_ID,
		});

		expect(memory).toMatchObject({
			id: DOCUMENT_ID,
			agentId: MOCK_AGENT_ID,
			roomId: MOCK_AGENT_ID,
			entityId: MOCK_AGENT_ID,
			worldId: WORLD_ID,
			content: { text: "document body" },
			metadata: {
				type: MemoryType.DOCUMENT,
				documentId: CLIENT_DOCUMENT_ID,
				filename: "Quarterly.Report.PDF",
				originalFilename: "Quarterly.Report.PDF",
				contentType: "application/pdf",
				fileType: "application/pdf",
				title: "Quarterly.Report.PDF",
				fileExt: "pdf",
				fileSize: 42,
				source: "upload",
				textBacked: false,
			},
		});
	});

	it("generates an id and applies caller metadata after defaults", () => {
		const memory = createDocumentMemory({
			text: "notes",
			agentId: MOCK_AGENT_ID,
			clientDocumentId: CLIENT_DOCUMENT_ID,
			originalFilename: "README",
			contentType: "text/plain",
			worldId: WORLD_ID,
			fileSize: 5,
			customMetadata: { source: "character", title: "Custom title" },
		});

		expect(memory.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(memory.metadata).toMatchObject({
			fileExt: "readme",
			source: "character",
			title: "Custom title",
		});
	});
});

describe("preparePreChunkedFragmentMemories", () => {
	it("rejects an empty fragment collection", async () => {
		await expectElizaCode(
			preparePreChunkedFragmentMemories(preChunkArgs(runtimeWith(), [])),
			"DOCUMENT_FRAGMENTS_EMPTY",
		);
	});

	it("rejects blank text", async () => {
		await expectElizaCode(
			preparePreChunkedFragmentMemories(
				preChunkArgs(runtimeWith(), [
					{ text: " ", metadata: { startMs: 0, endMs: 1, segmentIds: ["a"] } },
				]),
			),
			"DOCUMENT_FRAGMENT_EMPTY_TEXT",
		);
	});

	it.each([
		{ startMs: -1, endMs: 1, segmentIds: ["a"] },
		{ startMs: 2, endMs: 1, segmentIds: ["a"] },
		{ startMs: Number.NaN, endMs: 1, segmentIds: ["a"] },
		{ startMs: 0, endMs: Number.POSITIVE_INFINITY, segmentIds: ["a"] },
	])("rejects invalid time anchors %#", async (metadata) => {
		await expectElizaCode(
			preparePreChunkedFragmentMemories(
				preChunkArgs(runtimeWith(), [{ text: "fragment", metadata }]),
			),
			"DOCUMENT_FRAGMENT_INVALID_ANCHOR",
		);
	});

	it("rejects overlapping fragments but allows an exact boundary tie", async () => {
		const runtime = runtimeWith();
		await expectElizaCode(
			preparePreChunkedFragmentMemories(
				preChunkArgs(runtime, [
					{
						text: "first",
						metadata: { startMs: 0, endMs: 10, segmentIds: ["a"] },
					},
					{
						text: "second",
						metadata: { startMs: 9, endMs: 12, segmentIds: ["b"] },
					},
				]),
			),
			"DOCUMENT_FRAGMENT_INVALID_ANCHOR",
		);

		const tied = await preparePreChunkedFragmentMemories(
			preChunkArgs(runtime, [
				{
					text: "first",
					metadata: { startMs: 0, endMs: 10, segmentIds: ["a"] },
				},
				{
					text: "second",
					metadata: { startMs: 10, endMs: 12, segmentIds: ["b"] },
				},
			]),
		);
		expect(tied.map((memory) => memory.metadata?.position)).toEqual([0, 1]);
	});

	it.each([undefined, [], [""], ["valid", 3]])(
		"rejects invalid segment ids %#",
		async (segmentIds) => {
			await expectElizaCode(
				preparePreChunkedFragmentMemories(
					preChunkArgs(runtimeWith(), [
						{
							text: "fragment",
							metadata: { startMs: 0, endMs: 1, segmentIds },
						},
					]),
				),
				"DOCUMENT_FRAGMENT_INVALID_SEGMENT_IDS",
			);
		},
	);

	it("rejects a segment id repeated in a later fragment", async () => {
		await expectElizaCode(
			preparePreChunkedFragmentMemories(
				preChunkArgs(runtimeWith(), [
					{
						text: "first",
						metadata: { startMs: 0, endMs: 1, segmentIds: ["same"] },
					},
					{
						text: "second",
						metadata: { startMs: 1, endMs: 2, segmentIds: ["same"] },
					},
				]),
			),
			"DOCUMENT_FRAGMENT_DUPLICATE_SEGMENT_ID",
		);
	});

	it("preserves ordered producer metadata while enforcing canonical fragment fields", async () => {
		const memories = await preparePreChunkedFragmentMemories({
			...preChunkArgs(runtimeWith(), [
				{
					text: "contains secret",
					metadata: {
						startMs: 0,
						endMs: 20,
						segmentIds: ["s1", "s2"],
						position: 99,
						custom: "producer",
					},
				},
			]),
			documentMetadata: { source: "youtube", collection: "interview" },
		});

		expect(memories).toHaveLength(1);
		expect(memories[0]).toMatchObject({
			agentId: MOCK_AGENT_ID,
			roomId: ROOM_ID,
			entityId: ENTITY_ID,
			worldId: WORLD_ID,
			content: { text: "contains [redacted]" },
			unique: false,
			metadata: {
				type: MemoryType.FRAGMENT,
				documentId: DOCUMENT_ID,
				position: 0,
				startMs: 0,
				endMs: 20,
				segmentIds: ["s1", "s2"],
				source: "youtube",
				documentTitle: "Meeting",
				collection: "interview",
				custom: "producer",
			},
		});
	});

	it("requires a non-empty embedding when vector enrichment is registered", async () => {
		const runtime = runtimeWith({
			getModel: (type: string) =>
				type === ModelType.TEXT_EMBEDDING ? async () => [1] : undefined,
			addEmbeddingToMemory: async (memory: Memory) => memory,
		});
		const error = await expectElizaCode(
			preparePreChunkedFragmentMemories(
				preChunkArgs(runtime, [
					{
						text: "fragment",
						metadata: { startMs: 0, endMs: 1, segmentIds: ["a"] },
					},
				]),
			),
			"DOCUMENT_FRAGMENT_EMBED_FAILED",
		);
		expect(error.cause).toBeUndefined();
	});

	it("preserves the embedding provider failure as the structured cause", async () => {
		const providerError = new Error("provider offline");
		const runtime = runtimeWith({
			getModel: (type: string) =>
				type === ModelType.TEXT_EMBEDDING ? async () => [1] : undefined,
			addEmbeddingToMemory: async () => {
				throw providerError;
			},
		});
		const error = await expectElizaCode(
			preparePreChunkedFragmentMemories(
				preChunkArgs(runtime, [
					{
						text: "fragment",
						metadata: { startMs: 0, endMs: 1, segmentIds: ["a"] },
					},
				]),
			),
			"DOCUMENT_FRAGMENT_EMBED_FAILED",
		);
		expect(error.cause).toBe(providerError);
		expect(error.context).toEqual({ documentId: DOCUMENT_ID, position: 0 });
	});

	it("returns enriched fragments when the runtime attaches an embedding", async () => {
		const runtime = runtimeWith({
			getModel: (type: string) =>
				type === ModelType.TEXT_EMBEDDING ? async () => [1] : undefined,
			addEmbeddingToMemory: async (memory: Memory) => {
				memory.embedding = [0.2, 0.8];
				return memory;
			},
		});
		const memories = await preparePreChunkedFragmentMemories(
			preChunkArgs(runtime, [
				{
					text: "fragment",
					metadata: { startMs: 0, endMs: 1, segmentIds: ["a"] },
				},
			]),
		);
		expect(memories[0]?.embedding).toEqual([0.2, 0.8]);
	});
});
