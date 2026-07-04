/**
 * Unit tests for `DocumentService`'s batched fragment-embedding path
 * (`TEXT_EMBEDDING_BATCH`): one batch call embeds every fragment in order, and an
 * absent batch model or a wrong-shaped batch result falls back to the serial
 * per-fragment embed with no fragment left unembedded. Drives `createMockRuntime`
 * with a deterministic text-derived fake embedding (a vector traces back to the
 * exact fragment text) — no live model or DB.
 */
import { describe, expect, test } from "vitest";
import { createMockRuntime } from "../../testing/mock-runtime";
import type { Memory, UUID } from "../../types";
import { ModelType } from "../../types";
import { DocumentService } from "./service.ts";

const DOCUMENT_FRAGMENTS_TABLE = "document_fragments";

/**
 * Deterministic, text-derived "embedding": distinct per distinct text so a
 * vector can be traced back to the exact text it was generated from. This lets
 * the tests prove (1) the right vector landed on the right fragment (ordering)
 * and (2) the batch path embeds the SAME text the serial path embeds.
 */
function vecOf(text: string): number[] {
	let h = 0;
	for (let i = 0; i < text.length; i++) {
		h = (h * 31 + text.charCodeAt(i)) >>> 0;
	}
	return [h % 100000, text.length];
}

// Six distinct ~70-char paragraphs. With the small split target below each
// paragraph becomes its own fragment (two never fit in one chunk), so every
// run produces several fragments with distinct text → distinct vectors.
const DOC_TEXT = [
	"Alpha paragraph: the quick brown fox reviews the refund policy details.",
	"Bravo paragraph: service level agreements and uptime commitments listed.",
	"Charlie paragraph: data retention windows and deletion guarantees noted.",
	"Delta paragraph: support escalation paths and the on-call rotation table.",
	"Echo paragraph: billing cycles, proration, and invoice dispute handling.",
	"Foxtrot paragraph: security posture, encryption at rest and in transit.",
].join("\n\n");

// Force several small fragments regardless of the default 1500-token target.
const SPLIT_OPTS = { targetTokens: 24, overlap: 2, modelContextSize: 4096 };

const ITEM_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID;

function makeItem() {
	return {
		id: ITEM_ID,
		content: { text: DOC_TEXT },
		metadata: { source: "unit-test" },
	};
}

interface Captured {
	fragments: Memory[];
	documents: Memory[];
}

/** Snapshot persisted memories per table, copying the embedding at call time. */
function captureCreateMemory(captured: Captured) {
	return async (memory: Memory, table: string): Promise<UUID> => {
		const snapshot: Memory = {
			...memory,
			embedding: memory.embedding ? [...memory.embedding] : undefined,
		};
		if (table === DOCUMENT_FRAGMENTS_TABLE) {
			captured.fragments.push(snapshot);
		} else {
			captured.documents.push(snapshot);
		}
		return memory.id as UUID;
	};
}

describe("DocumentService — batched fragment embedding (TEXT_EMBEDDING_BATCH)", () => {
	test("batch model registered → ONE batch call embeds all fragments in order and persists them", async () => {
		let batchCalls = 0;
		let singleEmbedCalls = 0;
		let serialEmbedCalls = 0;
		let batchTexts: string[] = [];
		const captured: Captured = { fragments: [], documents: [] };

		const runtime = createMockRuntime({
			getMemoryById: async () => null,
			updateMemory: async () => true,
			createMemory: captureCreateMemory(captured),
			// Presence (truthiness) of a batch handler is all the service checks.
			getModel: (type: string) =>
				type === ModelType.TEXT_EMBEDDING_BATCH
					? async () => [] // never invoked; useModel is used instead
					: undefined,
			useModel: (type: string, params: { text?: string; texts?: string[] }) => {
				if (type === ModelType.TEXT_EMBEDDING_BATCH) {
					batchCalls++;
					batchTexts = params.texts ?? [];
					return Promise.resolve(batchTexts.map(vecOf));
				}
				if (type === ModelType.TEXT_EMBEDDING) {
					singleEmbedCalls++;
					return Promise.resolve(vecOf(params.text ?? ""));
				}
				throw new Error(`unexpected model ${type}`);
			},
			addEmbeddingToMemory: async (memory: Memory) => {
				serialEmbedCalls++;
				memory.embedding = vecOf(memory.content.text ?? "");
				return memory;
			},
		});

		const service = new DocumentService(runtime);
		await service._internalAddDocument(makeItem(), SPLIT_OPTS);

		// Multiple fragments → batching is meaningful.
		expect(captured.fragments.length).toBeGreaterThanOrEqual(2);
		// Exactly ONE batch round-trip (not N), and the serial path untouched.
		expect(batchCalls).toBe(1);
		expect(singleEmbedCalls).toBe(0);
		expect(serialEmbedCalls).toBe(0);
		// The batch embedded exactly the fragment texts (count match).
		expect(batchTexts.length).toBe(captured.fragments.length);
		// Every fragment was persisted WITH its embedding, and that embedding is
		// the vector for ITS OWN text — proving the right vector landed on the
		// right fragment (ordering) and that the embedded text matches what the
		// serial addEmbeddingToMemory path would have embedded (content.text).
		for (const fragment of captured.fragments) {
			expect(fragment.embedding).toEqual(vecOf(fragment.content.text ?? ""));
		}
		// Batch texts are exactly the fragment texts, in fragment order.
		expect(batchTexts).toEqual(
			captured.fragments.map((f) => f.content.text ?? ""),
		);
	});

	test("no batch model → falls back to the serial per-fragment path and embeds + persists all N", async () => {
		let batchCalls = 0;
		let serialEmbedCalls = 0;
		const captured: Captured = { fragments: [], documents: [] };

		const runtime = createMockRuntime({
			getMemoryById: async () => null,
			updateMemory: async () => true,
			createMemory: captureCreateMemory(captured),
			// No batch model registered.
			getModel: () => undefined,
			useModel: (type: string) => {
				if (type === ModelType.TEXT_EMBEDDING_BATCH) {
					batchCalls++;
				}
				return Promise.resolve([]);
			},
			addEmbeddingToMemory: async (memory: Memory) => {
				serialEmbedCalls++;
				memory.embedding = vecOf(memory.content.text ?? "");
				return memory;
			},
		});

		const service = new DocumentService(runtime);
		await service._internalAddDocument(makeItem(), SPLIT_OPTS);

		expect(captured.fragments.length).toBeGreaterThanOrEqual(2);
		// Batch model absent → batch is never attempted.
		expect(batchCalls).toBe(0);
		// One embed per fragment via the serial path.
		expect(serialEmbedCalls).toBe(captured.fragments.length);
		for (const fragment of captured.fragments) {
			expect(fragment.embedding).toEqual(vecOf(fragment.content.text ?? ""));
		}
	});

	test("batch returns the wrong vector count → falls back to serial (no fragment left unembedded)", async () => {
		let batchCalls = 0;
		let serialEmbedCalls = 0;
		const captured: Captured = { fragments: [], documents: [] };

		const runtime = createMockRuntime({
			getMemoryById: async () => null,
			updateMemory: async () => true,
			createMemory: captureCreateMemory(captured),
			getModel: (type: string) =>
				type === ModelType.TEXT_EMBEDDING_BATCH ? async () => [] : undefined,
			useModel: (type: string) => {
				if (type === ModelType.TEXT_EMBEDDING_BATCH) {
					batchCalls++;
					// WRONG shape: one vector for N (>= 2) texts → must trigger fallback.
					return Promise.resolve([[0, 0]]);
				}
				throw new Error(`unexpected model ${type}`);
			},
			addEmbeddingToMemory: async (memory: Memory) => {
				serialEmbedCalls++;
				memory.embedding = vecOf(memory.content.text ?? "");
				return memory;
			},
		});

		const service = new DocumentService(runtime);
		await service._internalAddDocument(makeItem(), SPLIT_OPTS);

		expect(captured.fragments.length).toBeGreaterThanOrEqual(2);
		// Batch was attempted exactly once, then abandoned for the serial path.
		expect(batchCalls).toBe(1);
		expect(serialEmbedCalls).toBe(captured.fragments.length);
		// No fragment left unembedded; each carries the vector for its own text.
		for (const fragment of captured.fragments) {
			expect(fragment.embedding).toBeDefined();
			expect(fragment.embedding).toEqual(vecOf(fragment.content.text ?? ""));
		}
	});
});
