/**
 * Exercises batched document embeddings through a real AgentRuntime model
 * registry and in-memory persistence, including both serial fallback paths.
 */
import { describe, expect, test } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import type { Character, JsonValue, Memory, UUID } from "../../types";
import { ModelType } from "../../types";
import { DocumentService } from "./service.ts";

const AGENT_ID = "00000000-0000-0000-0000-00000000b47c" as UUID;
const ITEM_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID;
const DOCUMENT_FRAGMENTS_TABLE = "document_fragments";

function vecOf(text: string): number[] {
	let hash = 0;
	for (let index = 0; index < text.length; index++) {
		hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
	}
	return [hash % 100_000, text.length];
}

const DOC_TEXT = [
	"Alpha paragraph: the quick brown fox reviews the refund policy details.",
	"Bravo paragraph: service level agreements and uptime commitments listed.",
	"Charlie paragraph: data retention windows and deletion guarantees noted.",
	"Delta paragraph: support escalation paths and the on-call rotation table.",
	"Echo paragraph: billing cycles, proration, and invoice dispute handling.",
	"Foxtrot paragraph: security posture, encryption at rest and in transit.",
].join("\n\n");

const SPLIT_OPTIONS = {
	targetTokens: 24,
	overlap: 2,
	modelContextSize: 4096,
};

function makeItem() {
	return {
		id: ITEM_ID,
		content: { text: DOC_TEXT },
		metadata: { source: "unit-test" },
	};
}

type ModelParams = Record<string, JsonValue | object>;

function requireText(params: ModelParams): string {
	const text = params.text;
	if (typeof text !== "string") {
		throw new Error("Single embedding request must contain text");
	}
	return text;
}

function requireTexts(params: ModelParams): string[] {
	const texts = params.texts;
	if (!Array.isArray(texts)) {
		throw new Error("Batch embedding request must contain texts");
	}
	const validated: string[] = [];
	for (const text of texts) {
		if (typeof text !== "string") {
			throw new Error("Batch embedding texts must all be strings");
		}
		validated.push(text);
	}
	return validated;
}

interface HarnessOptions {
	single: (text: string) => number[] | Promise<number[]>;
	batch?: (texts: string[]) => number[][] | Promise<number[][]>;
}

async function makeHarness(options: HarnessOptions): Promise<{
	runtime: AgentRuntime;
	service: DocumentService;
}> {
	const adapter = new InMemoryDatabaseAdapter();
	await adapter.initialize();
	const runtime = new AgentRuntime({
		agentId: AGENT_ID,
		character: {
			name: "DocumentBatchEmbeddingTestAgent",
			bio: "Exercises document embedding storage semantics.",
			settings: {},
		} as Character,
		adapter,
		logLevel: "fatal",
	});
	runtime.registerModel(
		ModelType.TEXT_EMBEDDING,
		async (_runtime, params) => options.single(requireText(params)),
		"document-batch-test-single",
		100,
	);
	const batch = options.batch;
	if (batch) {
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING_BATCH,
			async (_runtime, params) => batch(requireTexts(params)),
			"document-batch-test-batch",
			100,
		);
	}
	return { runtime, service: new DocumentService(runtime) };
}

function fragmentPosition(fragment: Memory): number {
	const position = fragment.metadata?.position;
	if (typeof position !== "number") {
		throw new Error(`Fragment ${fragment.id} has no numeric position`);
	}
	return position;
}

async function getStoredFragments(runtime: AgentRuntime): Promise<Memory[]> {
	const memories = await runtime.getMemories({
		tableName: DOCUMENT_FRAGMENTS_TABLE,
		agentId: AGENT_ID,
		roomId: AGENT_ID,
		count: 20,
	});
	return memories
		.filter((memory) => memory.metadata?.documentId === ITEM_ID)
		.sort((left, right) => fragmentPosition(left) - fragmentPosition(right));
}

function expectTextDerivedEmbeddings(fragments: Memory[]): void {
	for (const fragment of fragments) {
		const text = fragment.content.text;
		if (typeof text !== "string") {
			throw new Error(`Fragment ${fragment.id} has no text`);
		}
		expect(fragment.embedding).toEqual(vecOf(text));
	}
}

describe("DocumentService batched fragment embedding", () => {
	test("uses one batch call and persists every ordered vector", async () => {
		const batches: string[][] = [];
		let singleCalls = 0;
		const { runtime, service } = await makeHarness({
			single: (text) => {
				singleCalls++;
				return vecOf(text);
			},
			batch: (texts) => {
				batches.push([...texts]);
				return texts.map(vecOf);
			},
		});

		await service._internalAddDocument(makeItem(), SPLIT_OPTIONS);

		const fragments = await getStoredFragments(runtime);
		expect(fragments).toHaveLength(6);
		expect(batches).toHaveLength(1);
		expect(singleCalls).toBe(0);
		expect(batches[0]).toEqual(
			fragments.map((fragment) => fragment.content.text),
		);
		expectTextDerivedEmbeddings(fragments);
		await expect(runtime.getMemoryById(ITEM_ID)).resolves.toMatchObject({
			id: ITEM_ID,
			metadata: { documentId: ITEM_ID },
		});
	});

	test("uses the real single-model path when no batch model is registered", async () => {
		const singleTexts: string[] = [];
		const { runtime, service } = await makeHarness({
			single: (text) => {
				singleTexts.push(text);
				return vecOf(text);
			},
		});

		expect(runtime.getModel(ModelType.TEXT_EMBEDDING_BATCH)).toBeUndefined();
		await service._internalAddDocument(makeItem(), SPLIT_OPTIONS);

		const fragments = await getStoredFragments(runtime);
		expect(fragments).toHaveLength(6);
		expect(singleTexts).toEqual(
			fragments.map((fragment) => fragment.content.text),
		);
		expectTextDerivedEmbeddings(fragments);
	});

	test("rejects a one-of-six batch result and serially embeds every fragment", async () => {
		let batchCalls = 0;
		const singleTexts: string[] = [];
		const { runtime, service } = await makeHarness({
			single: (text) => {
				singleTexts.push(text);
				return vecOf(text);
			},
			batch: () => {
				batchCalls++;
				return [[0, 0]];
			},
		});

		await service._internalAddDocument(makeItem(), SPLIT_OPTIONS);

		const fragments = await getStoredFragments(runtime);
		expect(fragments).toHaveLength(6);
		expect(batchCalls).toBe(1);
		expect(singleTexts).toEqual(
			fragments.map((fragment) => fragment.content.text),
		);
		expectTextDerivedEmbeddings(fragments);
		expect(runtime.getRecentReportedErrors()).toContainEqual(
			expect.objectContaining({
				scope: "DocumentService.batchFragmentEmbedding",
				message: "TEXT_EMBEDDING_BATCH returned 1 vectors for 6 fragments",
				context: expect.objectContaining({ fragmentCount: 6 }),
			}),
		);
	});

	test("reports a batch provider error and persists serially generated vectors", async () => {
		const singleTexts: string[] = [];
		const { runtime, service } = await makeHarness({
			single: (text) => {
				singleTexts.push(text);
				return vecOf(text);
			},
			batch: () => {
				throw new Error("batch embedding endpoint unavailable");
			},
		});

		await service._internalAddDocument(makeItem(), SPLIT_OPTIONS);

		const fragments = await getStoredFragments(runtime);
		expect(fragments).toHaveLength(6);
		expect(singleTexts).toEqual(
			fragments.map((fragment) => fragment.content.text),
		);
		expectTextDerivedEmbeddings(fragments);
		expect(runtime.getRecentReportedErrors()).toContainEqual(
			expect.objectContaining({
				scope: "DocumentService.batchFragmentEmbedding",
				message: "batch embedding endpoint unavailable",
				context: expect.objectContaining({ fragmentCount: 6 }),
			}),
		);
	});
});
