/**
 * Regression for #16021: an embed-time failure in `addDocument` must not leave
 * an orphaned zero-fragment DOCUMENT row in the index.
 *
 * `processFragmentsSynchronously` counts and logs per-chunk embedding failures
 * rather than throwing, so before the compensation fix a document whose every
 * chunk failed to embed still had its parent DOCUMENT row persisted (visible in
 * document lists, unmatchable in fragment search). These tests drive the real
 * ingestion path with `createMockRuntime` — no live model or DB — and prove the
 * parent row is rolled back and the failure is reported.
 */
import { describe, expect, test, vi } from "vitest";
import { createMockRuntime, MOCK_AGENT_ID } from "../../testing/mock-runtime";
import type { Memory, UUID } from "../../types";
import { ModelType } from "../../types";
import { isElizaError } from "../../errors";
import { DocumentService } from "./service.ts";

const DOCUMENTS_TABLE = "documents";
const DOCUMENT_FRAGMENTS_TABLE = "document_fragments";

function embeddingFor(text: string): number[] {
	return [text.length, 1, 0.5];
}

describe("DocumentService embed-time orphan compensation (#16021)", () => {
	test("rolls back the parent document row when every chunk fails to embed", async () => {
		const created: Array<{ memory: Memory; table: string }> = [];
		const deleted: UUID[] = [];
		const reported: Array<{ scope: string; context?: Record<string, unknown> }> =
			[];

		const runtime = createMockRuntime({
			getSetting: () => undefined,
			getModel: (type: string) =>
				type === ModelType.TEXT_EMBEDDING
					? async () => {
							throw new Error("embedding model down");
						}
					: undefined,
			getMemoryById: async () => null,
			getMemories: async () => [],
			createMemory: async (memory: Memory, table: string): Promise<UUID> => {
				created.push({ memory, table });
				return memory.id as UUID;
			},
			updateMemory: async () => true,
			deleteMemory: async (id: UUID) => {
				deleted.push(id);
			},
			// Embedding fails for every chunk — this is the embed-time failure.
			useModel: async (type: string) => {
				if (type === ModelType.TEXT_EMBEDDING) {
					throw new Error("embedding model down");
				}
				throw new Error(`unexpected model ${type}`);
			},
			reportError: (scope: string, _error: unknown, context) => {
				reported.push({ scope, context });
			},
		});
		const service = new DocumentService(runtime);

		let thrown: unknown;
		try {
			await service.addDocument({
				agentId: MOCK_AGENT_ID,
				worldId: MOCK_AGENT_ID,
				roomId: MOCK_AGENT_ID,
				entityId: MOCK_AGENT_ID,
				content: "A document whose embedding backend is unavailable.",
				contentType: "text/plain",
				originalFilename: "embed-down.txt",
			});
		} catch (error) {
			thrown = error;
		}

		// The parent DOCUMENT row was written...
		const documentWrites = created.filter(
			(entry) => entry.table === DOCUMENTS_TABLE,
		);
		expect(documentWrites).toHaveLength(1);
		const documentId = documentWrites[0]?.memory.id as UUID;

		// ...no fragments persisted...
		expect(
			created.some((entry) => entry.table === DOCUMENT_FRAGMENTS_TABLE),
		).toBe(false);

		// ...and it was compensated away (no orphaned zero-fragment row remains).
		expect(deleted).toContain(documentId);

		// The failure is observable to the agent/owner escalation path.
		expect(reported.length).toBeGreaterThan(0);
		expect(reported[0]?.scope).toBe("DocumentService.addDocument");
		expect(reported[0]?.context?.documentId).toBe(documentId);

		// A typed, classified error propagates to the caller.
		expect(isElizaError(thrown)).toBe(true);
		expect((thrown as { code?: string }).code).toBe("DOCUMENT_EMBED_FAILED");
	});

	test("rolls back the parent document row when fragment persistence throws", async () => {
		const created: Array<{ memory: Memory; table: string }> = [];
		const deleted: UUID[] = [];
		const reported: string[] = [];

		const runtime = createMockRuntime({
			getSetting: () => undefined,
			getModel: (type: string) =>
				type === ModelType.TEXT_EMBEDDING
					? async () => embeddingFor("ok")
					: undefined,
			getMemoryById: async () => null,
			getMemories: async () => [],
			createMemory: async (memory: Memory, table: string): Promise<UUID> => {
				created.push({ memory, table });
				// Embedding succeeds, but persisting the fragment throws hard.
				if (table === DOCUMENT_FRAGMENTS_TABLE) {
					throw new Error("fragment store write failed");
				}
				return memory.id as UUID;
			},
			updateMemory: async () => true,
			deleteMemory: async (id: UUID) => {
				deleted.push(id);
			},
			useModel: async (type: string, params: { text?: string }) => {
				if (type === ModelType.TEXT_EMBEDDING) {
					return embeddingFor(params.text ?? "");
				}
				throw new Error(`unexpected model ${type}`);
			},
			reportError: (scope: string) => {
				reported.push(scope);
			},
		});
		const service = new DocumentService(runtime);

		// Fragment save failures are caught+counted by the pipeline (not thrown),
		// so this still surfaces as an embed-time zero-fragment rollback.
		await expect(
			service.addDocument({
				agentId: MOCK_AGENT_ID,
				worldId: MOCK_AGENT_ID,
				roomId: MOCK_AGENT_ID,
				entityId: MOCK_AGENT_ID,
				content: "A document whose fragment writes fail.",
				contentType: "text/plain",
				originalFilename: "store-fail.txt",
			}),
		).rejects.toThrow();

		const documentWrites = created.filter(
			(entry) => entry.table === DOCUMENTS_TABLE,
		);
		expect(documentWrites).toHaveLength(1);
		const documentId = documentWrites[0]?.memory.id as UUID;

		expect(deleted).toContain(documentId);
		expect(reported).toContain("DocumentService.addDocument");
	});

	test("does not roll back a document that embeds at least one fragment", async () => {
		const created: Array<{ memory: Memory; table: string }> = [];
		const deleted: UUID[] = [];

		const runtime = createMockRuntime({
			getSetting: () => undefined,
			getModel: (type: string) =>
				type === ModelType.TEXT_EMBEDDING
					? async () => embeddingFor("ok")
					: undefined,
			getMemoryById: async () => null,
			getMemories: async () => [],
			createMemory: async (memory: Memory, table: string): Promise<UUID> => {
				created.push({ memory, table });
				return memory.id as UUID;
			},
			updateMemory: async () => true,
			deleteMemory: async (id: UUID) => {
				deleted.push(id);
			},
			useModel: async (type: string, params: { text?: string }) => {
				if (type === ModelType.TEXT_EMBEDDING) {
					return embeddingFor(params.text ?? "");
				}
				throw new Error(`unexpected model ${type}`);
			},
			reportError: vi.fn(),
		});
		const service = new DocumentService(runtime);

		const result = await service.addDocument({
			agentId: MOCK_AGENT_ID,
			worldId: MOCK_AGENT_ID,
			roomId: MOCK_AGENT_ID,
			entityId: MOCK_AGENT_ID,
			content: "A healthy document that embeds normally.",
			contentType: "text/plain",
			originalFilename: "healthy.txt",
		});

		expect(result.fragmentCount).toBeGreaterThan(0);
		expect(
			created.some((entry) => entry.table === DOCUMENT_FRAGMENTS_TABLE),
		).toBe(true);
		// The healthy parent row is never rolled back.
		expect(deleted).not.toContain(result.storedDocumentMemoryId);
	});
});
