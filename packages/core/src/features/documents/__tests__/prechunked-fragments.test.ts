/**
 * Covers the pre-chunked `fragments` ingest seam (#14806): producers that own
 * their chunk boundaries (transcript segment groups with startMs/endMs time
 * anchors) hand fragments to DocumentService.addDocument /
 * processFragmentsSynchronously instead of the token splitter. Deterministic:
 * a real DocumentService + real processor run against a runtime stub that
 * captures createMemory rows and serves a fixed embedding vector; no live
 * model or database.
 */
import { describe, expect, it, vi } from "vitest";
import type { Memory, UUID } from "../../../types";
import { MemoryType, ModelType } from "../../../types";
import { processFragmentsSynchronously } from "../document-processor";
import { DocumentService } from "../service";

interface CapturedWrite {
	memory: Memory;
	tableName: string;
}

function buildRuntime() {
	const writes: CapturedWrite[] = [];
	const runtime = {
		agentId: "agent-1" as UUID,
		getSetting: vi.fn((key: string) => {
			// Local embedding keeps validateModelConfig from demanding an API key;
			// rate limiting off keeps the test instant.
			if (key === "EMBEDDING_PROVIDER") return "local";
			if (key === "RATE_LIMIT_ENABLED") return "false";
			return undefined;
		}),
		useModel: vi.fn(async (modelType: string) => {
			if (modelType === ModelType.TEXT_EMBEDDING) return [0.1, 0.2, 0.3];
			throw new Error(`Unexpected model call: ${modelType}`);
		}),
		createMemory: vi.fn(async (memory: Memory, tableName: string) => {
			writes.push({ memory, tableName });
			return memory.id as UUID;
		}),
		getMemoryById: vi.fn(async () => null),
		getMemories: vi.fn(async (): Promise<Memory[]> => []),
		searchMemories: vi.fn(async (): Promise<Memory[]> => []),
		getModel: vi.fn((modelType: string) =>
			modelType === ModelType.TEXT_EMBEDDING ? vi.fn() : undefined,
		),
		deleteMemory: vi.fn(async () => undefined),
	};
	return { runtime, writes };
}

function fragmentWrites(writes: CapturedWrite[]): Memory[] {
	return writes
		.filter((w) => w.tableName === "document_fragments")
		.map((w) => w.memory);
}

const DOC_ID = "11111111-2222-4333-8444-555555555555" as UUID;

describe("processFragmentsSynchronously — pre-chunked fragments", () => {
	it("stores producer fragments verbatim with anchors merged onto metadata", async () => {
		const { runtime, writes } = buildRuntime();
		const count = await processFragmentsSynchronously({
			runtime: runtime as never,
			documentId: DOC_ID,
			fullDocumentText: "Alice: hello there\nBob: hi",
			agentId: runtime.agentId,
			contentType: "text/plain",
			documentTitle: "standup.txt",
			documentMetadata: {
				source: "transcript",
				transcriptId: "t-1",
				audioUrl: "/api/media/abc.wav",
			},
			fragments: [
				{
					text: "Alice: hello there",
					metadata: {
						segmentIds: ["s1"],
						startMs: 0,
						endMs: 1000,
						speakerLabels: ["Alice"],
					},
				},
				{
					text: "Bob: hi",
					metadata: { segmentIds: ["s2"], startMs: 1200, endMs: 2000 },
				},
			],
		});

		expect(count).toBe(2);
		const rows = fragmentWrites(writes);
		expect(rows).toHaveLength(2);

		// Fragment text is exactly what the producer supplied — no re-splitting.
		expect(rows.map((r) => r.content.text)).toEqual([
			"Alice: hello there",
			"Bob: hi",
		]);

		// Anchors ride the fragment metadata; document metadata is inherited.
		const first = rows[0].metadata as Record<string, unknown>;
		expect(first.startMs).toBe(0);
		expect(first.endMs).toBe(1000);
		expect(first.segmentIds).toEqual(["s1"]);
		expect(first.speakerLabels).toEqual(["Alice"]);
		expect(first.transcriptId).toBe("t-1");
		expect(first.audioUrl).toBe("/api/media/abc.wav");
		expect(first.type).toBe(MemoryType.FRAGMENT);
		expect(first.documentId).toBe(DOC_ID);
		expect(first.position).toBe(0);

		const second = rows[1].metadata as Record<string, unknown>;
		expect(second.startMs).toBe(1200);
		expect(second.position).toBe(1);
		expect(second.speakerLabels).toBeUndefined();
	});

	it("producer metadata cannot corrupt structural fragment fields", async () => {
		const { runtime, writes } = buildRuntime();
		await processFragmentsSynchronously({
			runtime: runtime as never,
			documentId: DOC_ID,
			fullDocumentText: "body",
			agentId: runtime.agentId,
			fragments: [
				{
					text: "body",
					metadata: {
						startMs: 5,
						position: 99,
						documentId: "spoofed",
						type: "spoofed",
					},
				},
			],
		});
		const [row] = fragmentWrites(writes);
		const meta = row.metadata as Record<string, unknown>;
		expect(meta.position).toBe(0);
		expect(meta.documentId).toBe(DOC_ID);
		expect(meta.type).toBe(MemoryType.FRAGMENT);
		expect(meta.startMs).toBe(5);
	});

	it("throws on an explicitly-empty fragments array", async () => {
		const { runtime } = buildRuntime();
		await expect(
			processFragmentsSynchronously({
				runtime: runtime as never,
				documentId: DOC_ID,
				fullDocumentText: "body",
				agentId: runtime.agentId,
				fragments: [],
			}),
		).rejects.toThrow(/must be non-empty/);
	});

	it("throws on empty fragment text", async () => {
		const { runtime } = buildRuntime();
		await expect(
			processFragmentsSynchronously({
				runtime: runtime as never,
				documentId: DOC_ID,
				fullDocumentText: "body",
				agentId: runtime.agentId,
				fragments: [{ text: "   " }],
			}),
		).rejects.toThrow(/empty text/);
	});

	it("throws on inverted or invalid time anchors", async () => {
		const { runtime } = buildRuntime();
		await expect(
			processFragmentsSynchronously({
				runtime: runtime as never,
				documentId: DOC_ID,
				fullDocumentText: "body",
				agentId: runtime.agentId,
				fragments: [{ text: "a", metadata: { startMs: 500, endMs: 100 } }],
			}),
		).rejects.toThrow(/endMs 100 before startMs 500/);

		await expect(
			processFragmentsSynchronously({
				runtime: runtime as never,
				documentId: DOC_ID,
				fullDocumentText: "body",
				agentId: runtime.agentId,
				fragments: [{ text: "a", metadata: { startMs: Number.NaN } }],
			}),
		).rejects.toThrow(/invalid startMs/);

		await expect(
			processFragmentsSynchronously({
				runtime: runtime as never,
				documentId: DOC_ID,
				fullDocumentText: "body",
				agentId: runtime.agentId,
				fragments: [{ text: "a", metadata: { endMs: -3 } }],
			}),
		).rejects.toThrow(/invalid endMs/);
	});

	it("nothing is persisted when validation rejects the batch", async () => {
		const { runtime, writes } = buildRuntime();
		await expect(
			processFragmentsSynchronously({
				runtime: runtime as never,
				documentId: DOC_ID,
				fullDocumentText: "body",
				agentId: runtime.agentId,
				fragments: [
					{ text: "fine", metadata: { startMs: 0, endMs: 10 } },
					{ text: "" },
				],
			}),
		).rejects.toThrow(/empty text/);
		expect(fragmentWrites(writes)).toHaveLength(0);
	});

	it("all-or-nothing: a single embed failure throws and persists no fragment", async () => {
		// One fragment embeds fine, the next returns a zero vector (embed failure).
		// The pre-chunked path must reject the whole batch rather than index a
		// partial set that would leave an anchor gap the PII projection trusts.
		const { runtime, writes } = buildRuntime();
		runtime.useModel = vi.fn(async (modelType: string, args: unknown) => {
			if (modelType !== ModelType.TEXT_EMBEDDING) {
				throw new Error(`Unexpected model call: ${modelType}`);
			}
			const text = (args as { text: string }).text;
			return text === "Bob: hi" ? [] : [0.1, 0.2, 0.3];
		}) as never;

		await expect(
			processFragmentsSynchronously({
				runtime: runtime as never,
				documentId: DOC_ID,
				fullDocumentText: "Alice: hello there\nBob: hi",
				agentId: runtime.agentId,
				fragments: [
					{
						text: "Alice: hello there",
						metadata: { segmentIds: ["s1"], startMs: 0, endMs: 1000 },
					},
					{
						text: "Bob: hi",
						metadata: { segmentIds: ["s2"], startMs: 1200, endMs: 2000 },
					},
				],
			}),
		).rejects.toThrow(/pre-chunked fragment/i);

		// Atomic: the fragment that embedded fine is NOT persisted either —
		// embeddings are all validated before any write.
		expect(fragmentWrites(writes)).toHaveLength(0);
	});

	it("pre-chunked fragments bypass contextual retrieval (verbatim text)", async () => {
		// With CTX_DOCUMENTS_ENABLED the splitter path would prepend LLM context to
		// each chunk's stored text; the pre-chunked path must NOT, or the stored
		// text stops matching its byte-exact time anchors. buildRuntime's useModel
		// throws on any non-embedding call, so a stored-verbatim result also proves
		// the contextualization TEXT model was never invoked.
		const { runtime, writes } = buildRuntime();
		runtime.getSetting = vi.fn((key: string) => {
			if (key === "EMBEDDING_PROVIDER") return "local";
			if (key === "RATE_LIMIT_ENABLED") return "false";
			if (key === "CTX_DOCUMENTS_ENABLED") return "true";
			return undefined;
		}) as never;

		const count = await processFragmentsSynchronously({
			runtime: runtime as never,
			documentId: DOC_ID,
			fullDocumentText: "Alice: hello there\nBob: hi",
			agentId: runtime.agentId,
			fragments: [
				{
					text: "Alice: hello there",
					metadata: { segmentIds: ["s1"], startMs: 0, endMs: 1000 },
				},
				{
					text: "Bob: hi",
					metadata: { segmentIds: ["s2"], startMs: 1200, endMs: 2000 },
				},
			],
		});
		expect(count).toBe(2);
		expect(fragmentWrites(writes).map((r) => r.content.text)).toEqual([
			"Alice: hello there",
			"Bob: hi",
		]);
	});

	it("without fragments the splitter path is unchanged (no anchor keys)", async () => {
		const { runtime, writes } = buildRuntime();
		const count = await processFragmentsSynchronously({
			runtime: runtime as never,
			documentId: DOC_ID,
			fullDocumentText: "plain body text with no producer chunking",
			agentId: runtime.agentId,
		});
		expect(count).toBeGreaterThan(0);
		const [row] = fragmentWrites(writes);
		const meta = row.metadata as Record<string, unknown>;
		expect(meta.startMs).toBeUndefined();
		expect(meta.segmentIds).toBeUndefined();
	});
});

describe("DocumentService.addDocument — fragments plumb through end to end", () => {
	it("persists the document row plus anchored fragment rows", async () => {
		const { runtime, writes } = buildRuntime();
		const svc = new (
			DocumentService as new (
				runtime: unknown,
			) => DocumentService
		)(runtime);

		const res = await svc.addDocument({
			worldId: runtime.agentId,
			roomId: runtime.agentId,
			entityId: runtime.agentId,
			clientDocumentId: DOC_ID,
			contentType: "text/plain",
			originalFilename: "standup.txt",
			content: "Alice: hello there\nBob: hi",
			metadata: { transcriptId: "t-1", source: "transcript" },
			fragments: [
				{
					text: "Alice: hello there",
					metadata: { segmentIds: ["s1"], startMs: 0, endMs: 1000 },
				},
				{
					text: "Bob: hi",
					metadata: { segmentIds: ["s2"], startMs: 1200, endMs: 2000 },
				},
			],
		});

		expect(res.fragmentCount).toBe(2);
		const docRows = writes.filter((w) => w.tableName === "documents");
		expect(docRows).toHaveLength(1);

		const rows = fragmentWrites(writes);
		expect(rows).toHaveLength(2);
		const meta = rows[1].metadata as Record<string, unknown>;
		expect(meta.startMs).toBe(1200);
		expect(meta.endMs).toBe(2000);
		expect(meta.transcriptId).toBe("t-1");
		expect(meta.position).toBe(1);
	});

	it("a malformed batch persists no document row and no fragment row", async () => {
		// Regression for the partial-write bug: validation is hoisted ahead of the
		// document-row write, so a rejected batch leaves NO orphaned zero-fragment
		// document stub in the documents table.
		const { runtime, writes } = buildRuntime();
		const svc = new (
			DocumentService as new (
				runtime: unknown,
			) => DocumentService
		)(runtime);

		await expect(
			svc.addDocument({
				worldId: runtime.agentId,
				roomId: runtime.agentId,
				entityId: runtime.agentId,
				clientDocumentId: DOC_ID,
				contentType: "text/plain",
				originalFilename: "standup.txt",
				content: "Alice: hello there\nBob: hi",
				metadata: { transcriptId: "t-1", source: "transcript" },
				fragments: [
					{
						text: "Alice: hello there",
						metadata: { segmentIds: ["s1"], startMs: 0, endMs: 1000 },
					},
					// endMs precedes startMs — invalid ASR segment.
					{ text: "Bob: hi", metadata: { startMs: 2000, endMs: 100 } },
				],
			}),
		).rejects.toThrow(/endMs 100 before startMs 2000/);

		expect(writes.filter((w) => w.tableName === "documents")).toHaveLength(0);
		expect(fragmentWrites(writes)).toHaveLength(0);
	});

	it("searchDocuments round-trips the anchors on stored fragments", async () => {
		const { runtime, writes } = buildRuntime();
		const svc = new (
			DocumentService as new (
				runtime: unknown,
			) => DocumentService
		)(runtime);

		await svc.addDocument({
			worldId: runtime.agentId,
			roomId: runtime.agentId,
			entityId: runtime.agentId,
			clientDocumentId: DOC_ID,
			contentType: "text/plain",
			originalFilename: "standup.txt",
			content: "Alice: hello there\nBob: hi",
			metadata: { transcriptId: "t-1", source: "transcript" },
			fragments: [
				{
					text: "Alice: hello there",
					metadata: { segmentIds: ["s1"], startMs: 0, endMs: 1000 },
				},
				{
					text: "Bob: hi",
					metadata: { segmentIds: ["s2"], startMs: 1200, endMs: 2000 },
				},
			],
		});

		// Serve the rows this very ingest stored — the same real search path the
		// /api/documents/search route and the DOCUMENT action call.
		const stored = fragmentWrites(writes).map((m, i) => ({
			...m,
			similarity: 0.9 - i * 0.1,
		}));
		runtime.searchMemories = vi.fn(async () => stored) as never;
		runtime.getMemories = vi.fn(async () => stored) as never;

		const hits = await svc.searchDocuments(
			{
				id: DOC_ID,
				agentId: runtime.agentId,
				roomId: runtime.agentId,
				content: { text: "hello" },
				createdAt: Date.now(),
			} as never,
			undefined,
		);

		expect(hits.length).toBeGreaterThan(0);
		const anchored = hits.find(
			(h) => (h.metadata as Record<string, unknown>)?.startMs === 0,
		);
		expect(anchored).toBeDefined();
		const anchorMeta = anchored?.metadata as Record<string, unknown>;
		expect(anchorMeta.endMs).toBe(1000);
		expect(anchorMeta.segmentIds).toEqual(["s1"]);
		expect(anchorMeta.transcriptId).toBe("t-1");
	});
});
