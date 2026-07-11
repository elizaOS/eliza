/**
 * Regression for #16111: `DocumentService.updateDocument` must be atomic with
 * respect to the document's fragments.
 *
 * The pre-fix order overwrote the parent DOCUMENT row and deleted every existing
 * fragment BEFORE re-embedding the new content. When re-embedding failed at
 * embed time (model down, dimension/shape mismatch — the same failure class as
 * #16021), the old (working) fragments were already gone and the new ones never
 * persisted: the document became searchable-empty AND its previous fragments
 * were permanently lost. This is data loss on edit, strictly worse than the
 * create-path orphan #16021 fixed.
 *
 * These tests drive the real `updateDocument` path with `createMockRuntime` — no
 * live model or DB — and prove the pre-edit fragments survive a failed edit.
 */
import { describe, expect, test } from "vitest";
import { isElizaError } from "../../errors";
import { createMockRuntime, MOCK_AGENT_ID } from "../../testing/mock-runtime";
import type { Memory, UUID } from "../../types";
import { MemoryType, ModelType } from "../../types";
import { DocumentService } from "./service.ts";

const DOCUMENT_FRAGMENTS_TABLE = "document_fragments";

const DOCUMENT_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd" as UUID;

function vecOf(text: string): number[] {
	let h = 0;
	for (let i = 0; i < text.length; i++) {
		h = (h * 31 + text.charCodeAt(i)) >>> 0;
	}
	return [h % 100000, text.length];
}

/** The parent DOCUMENT row as it exists before the edit. */
function makeExistingDocument(): Memory {
	return {
		id: DOCUMENT_ID,
		entityId: MOCK_AGENT_ID,
		agentId: MOCK_AGENT_ID,
		roomId: MOCK_AGENT_ID,
		worldId: MOCK_AGENT_ID,
		content: { text: "ORIGINAL document content that already has fragments." },
		metadata: {
			type: MemoryType.DOCUMENT,
			documentId: DOCUMENT_ID,
			source: "unit-test",
			filename: "notes.txt",
			originalFilename: "notes.txt",
			title: "Notes",
			contentType: "text/plain",
			fileExt: "txt",
			scope: "global",
		},
		createdAt: 1_000,
	} as Memory;
}

/** Two pre-existing, working fragments for the document. */
function makeExistingFragments(): Memory[] {
	return [0, 1].map(
		(i) =>
			({
				id: `ffffffff-ffff-ffff-ffff-00000000000${i}` as UUID,
				entityId: MOCK_AGENT_ID,
				agentId: MOCK_AGENT_ID,
				roomId: MOCK_AGENT_ID,
				worldId: MOCK_AGENT_ID,
				content: { text: `ORIGINAL fragment ${i}` },
				embedding: vecOf(`ORIGINAL fragment ${i}`),
				metadata: {
					type: MemoryType.FRAGMENT,
					documentId: DOCUMENT_ID,
					position: i,
				},
				createdAt: 1_000 + i,
			}) as Memory,
	);
}

/**
 * An in-memory fragment/document store the mock runtime reads and mutates, so a
 * failed edit's effect on the persisted fragments is observable.
 */
function makeStore() {
	const document = makeExistingDocument();
	const fragments = makeExistingFragments();
	return {
		document,
		// Fragment rows keyed by id (the searchable state we assert on).
		fragments: new Map<string, Memory>(
			fragments.map((fragment) => [fragment.id as string, fragment]),
		),
	};
}

const NEW_CONTENT =
	"COMPLETELY NEW replacement content that must be re-fragmented and re-embedded.";

describe("DocumentService.updateDocument atomicity (#16111)", () => {
	test("an embed-time failure during re-fragmentation preserves the existing fragments", async () => {
		const store = makeStore();
		const reported: Array<{ scope: string }> = [];

		let runtime = createMockRuntime();
		runtime = createMockRuntime({
			agentId: MOCK_AGENT_ID,
			getSetting: () => undefined,
			getMemoryById: async (id: UUID) =>
				id === DOCUMENT_ID ? store.document : null,
			getMemories: async (params: { tableName: string }) => {
				if (params.tableName === DOCUMENT_FRAGMENTS_TABLE) {
					return [...store.fragments.values()];
				}
				return [];
			},
			updateMemories: async (memories) => {
				const memory = memories[0] as {
					id?: string;
					content?: { text?: string };
					metadata?: Record<string, unknown>;
				};
				if (memory.id === DOCUMENT_ID) {
					store.document.content = {
						text: memory.content?.text ?? store.document.content.text,
					};
					if (memory.metadata) {
						store.document.metadata = memory.metadata as Memory["metadata"];
					}
				}
			},
			deleteMemories: async (ids) => {
				for (const id of ids) store.fragments.delete(id as string);
			},
			createMemories: async (items): Promise<UUID[]> => {
				for (const { memory, tableName } of items) {
					if (tableName === DOCUMENT_FRAGMENTS_TABLE) {
						store.fragments.set(memory.id as string, memory);
					}
				}
				return items.map(({ memory }) => memory.id as UUID);
			},
			transaction: async (callback) => callback(runtime),
			// No batch model → serial per-fragment embed path.
			getModel: () => undefined,
			// Embedding is DOWN — every re-embed of the new content fails.
			addEmbeddingToMemory: async () => {
				throw new Error("embedding model down");
			},
			useModel: async (type: string) => {
				if (type === ModelType.TEXT_EMBEDDING) {
					throw new Error("embedding model down");
				}
				throw new Error(`unexpected model ${type}`);
			},
			reportError: (scope: string) => {
				reported.push({ scope });
			},
		});

		const service = new DocumentService(runtime);

		let thrown: unknown;
		try {
			await service.updateDocument({
				documentId: DOCUMENT_ID,
				content: NEW_CONTENT,
			});
		} catch (error) {
			thrown = error;
		}

		// The edit failed and surfaced a typed, classified error.
		expect(thrown).toBeDefined();
		expect(isElizaError(thrown)).toBe(true);
		expect((thrown as { code?: string }).code).toBe("DOCUMENT_UPDATE_FAILED");

		// The pre-edit fragments MUST survive — the document is not left empty.
		const survivingIds = [...store.fragments.keys()].sort();
		expect(store.fragments.size).toBe(2);
		expect(survivingIds).toEqual([
			"ffffffff-ffff-ffff-ffff-000000000000",
			"ffffffff-ffff-ffff-ffff-000000000001",
		]);
		for (const fragment of store.fragments.values()) {
			expect(fragment.metadata?.type).toBe(MemoryType.FRAGMENT);
			expect(fragment.content.text).toMatch(/^ORIGINAL fragment/);
		}

		// The parent row still reflects the ORIGINAL content, not the failed edit.
		expect(store.document.content.text).toBe(
			"ORIGINAL document content that already has fragments.",
		);

		// The failure is observable to the agent/owner escalation path.
		expect(
			reported.some((r) => r.scope === "DocumentService.updateDocument"),
		).toBe(true);
	});

	test("a healthy edit still re-fragments and re-embeds the new content", async () => {
		const store = makeStore();

		let runtime = createMockRuntime();
		runtime = createMockRuntime({
			agentId: MOCK_AGENT_ID,
			getSetting: () => undefined,
			getMemoryById: async (id: UUID) =>
				id === DOCUMENT_ID ? store.document : null,
			getMemories: async (params: { tableName: string }) => {
				if (params.tableName === DOCUMENT_FRAGMENTS_TABLE) {
					return [...store.fragments.values()];
				}
				return [];
			},
			updateMemories: async (memories) => {
				const memory = memories[0] as {
					id?: string;
					content?: { text?: string };
					metadata?: Record<string, unknown>;
				};
				if (memory.id === DOCUMENT_ID) {
					store.document.content = {
						text: memory.content?.text ?? store.document.content.text,
					};
					if (memory.metadata) {
						store.document.metadata = memory.metadata as Memory["metadata"];
					}
				}
			},
			deleteMemories: async (ids) => {
				for (const id of ids) store.fragments.delete(id as string);
			},
			createMemories: async (items): Promise<UUID[]> => {
				for (const { memory, tableName } of items) {
					if (tableName === DOCUMENT_FRAGMENTS_TABLE) {
						store.fragments.set(memory.id as string, memory);
					}
				}
				return items.map(({ memory }) => memory.id as UUID);
			},
			transaction: async (callback) => callback(runtime),
			getModel: () => undefined,
			addEmbeddingToMemory: async (memory: Memory) => {
				memory.embedding = vecOf(memory.content.text ?? "");
				return memory;
			},
			useModel: async (type: string, params: { text?: string }) => {
				if (type === ModelType.TEXT_EMBEDDING) {
					return vecOf(params.text ?? "");
				}
				throw new Error(`unexpected model ${type}`);
			},
			reportError: () => {},
		});

		const service = new DocumentService(runtime);

		const result = await service.updateDocument({
			documentId: DOCUMENT_ID,
			content: NEW_CONTENT,
		});

		// New content is fragmented + persisted; old fragments are gone.
		expect(result.fragmentCount).toBeGreaterThanOrEqual(1);
		expect(store.fragments.size).toBe(result.fragmentCount);
		for (const fragment of store.fragments.values()) {
			expect(fragment.content.text).not.toMatch(/^ORIGINAL fragment/);
			expect(fragment.embedding).toBeDefined();
		}
		// Parent row reflects the new content.
		expect(store.document.content.text).toBe(NEW_CONTENT);
	});

	test("a fragment persistence failure rolls back the parent and old fragments", async () => {
		const store = makeStore();
		let runtime = createMockRuntime();
		runtime = createMockRuntime({
			agentId: MOCK_AGENT_ID,
			getSetting: () => undefined,
			getMemoryById: async (id: UUID) =>
				id === DOCUMENT_ID ? store.document : null,
			getMemories: async (params: { tableName: string }) =>
				params.tableName === DOCUMENT_FRAGMENTS_TABLE
					? [...store.fragments.values()]
					: [],
			updateMemories: async (memories) => {
				const memory = memories[0];
				if (memory.id === DOCUMENT_ID && memory.content) {
					store.document.content = memory.content;
				}
			},
			deleteMemories: async (ids) => {
				for (const id of ids) store.fragments.delete(id as string);
			},
			createMemories: async (items): Promise<UUID[]> => {
				const first = items[0];
				if (first) store.fragments.set(first.memory.id as string, first.memory);
				throw new Error("fragment insert failed");
			},
			transaction: async (callback) => {
				const contentBefore = structuredClone(store.document.content);
				const fragmentsBefore = new Map(store.fragments);
				try {
					return await callback(runtime);
				} catch (error) {
					store.document.content = contentBefore;
					store.fragments = fragmentsBefore;
					throw error;
				}
			},
			getModel: () => undefined,
			addEmbeddingToMemory: async (memory: Memory) => {
				memory.embedding = vecOf(memory.content.text ?? "");
				return memory;
			},
			reportError: () => {},
		});

		await expect(
			new DocumentService(runtime).updateDocument({
				documentId: DOCUMENT_ID,
				content: NEW_CONTENT,
			}),
		).rejects.toMatchObject({ code: "DOCUMENT_UPDATE_FAILED" });

		expect(store.document.content.text).toBe(
			"ORIGINAL document content that already has fragments.",
		);
		expect(
			[...store.fragments.values()].map((fragment) => fragment.content.text),
		).toEqual(["ORIGINAL fragment 0", "ORIGINAL fragment 1"]);
	});
});
