/** Canonical BGE input boundaries for production document ingestion. */
import { describe, expect, it } from "vitest";
import {
	CANONICAL_EMBEDDING_MAX_INPUT_CODE_UNITS,
	prepareCanonicalEmbeddingInput,
} from "../../constants/embeddings.ts";
import { canonicalTestEmbedding } from "../../testing/canonical-embedding.ts";
import {
	createMockRuntime,
	MOCK_AGENT_ID,
} from "../../testing/mock-runtime.ts";
import type { IAgentRuntime, Memory, UUID } from "../../types";
import { ModelType } from "../../types";
import {
	preparePreChunkedFragmentMemories,
	processFragmentsSynchronously,
} from "./document-processor.ts";

const DOCUMENT_ID = "11111111-1111-1111-1111-111111111111" as UUID;

interface Harness {
	runtime: IAgentRuntime;
	embeddedTexts: string[];
	savedFragments: Memory[];
}

function makeHarness(
	options: { contextualize?: boolean; generatedContext?: string } = {},
): Harness {
	const embeddedTexts: string[] = [];
	const savedFragments: Memory[] = [];
	const settings: Record<string, string> = {
		BATCH_DELAY_MS: "0",
		BATCH_EMBEDDINGS: "false",
		CTX_DOCUMENTS_ENABLED: options.contextualize ? "true" : "false",
		EMBEDDING_DIMENSION: "384",
		EMBEDDING_PROVIDER: "local",
		MAX_CONCURRENT_REQUESTS: "100",
		MAX_INPUT_TOKENS: "4000",
		MAX_OUTPUT_TOKENS: "4096",
		RATE_LIMIT_ENABLED: "false",
		REQUESTS_PER_MINUTE: "500",
		TEXT_EMBEDDING_MODEL: "BAAI/bge-small-en-v1.5",
		TEXT_MODEL: "document-boundary-test",
		TOKENS_PER_MINUTE: "1000000",
	};

	const runtime = createMockRuntime({
		getSetting: (key: string) => settings[key] ?? null,
		getModel: (modelType: string) =>
			modelType === ModelType.TEXT_EMBEDDING
				? async () => canonicalTestEmbedding()
				: undefined,
		useModel: (async (modelType: string, params: unknown) => {
			if (modelType === ModelType.TEXT_LARGE) {
				return options.generatedContext ?? "context";
			}
			if (modelType !== ModelType.TEXT_EMBEDDING) {
				throw new Error(`Unexpected model request: ${modelType}`);
			}
			const text = (params as { text?: unknown }).text;
			if (typeof text !== "string") {
				throw new Error("Embedding request must contain text");
			}
			embeddedTexts.push(text);
			return canonicalTestEmbedding(text.length);
		}) as IAgentRuntime["useModel"],
		redactSecrets: (text: string) => text,
		createMemory: async (memory: Memory) => {
			savedFragments.push(memory);
			return memory.id as UUID;
		},
	});

	return { runtime, embeddedTexts, savedFragments };
}

function fragmentPosition(memory: Memory): number {
	const position = memory.metadata?.position;
	if (typeof position !== "number") {
		throw new Error(`Fragment ${memory.id} is missing its position`);
	}
	return position;
}

function expectCanonicalOrderedFragments(harness: Harness): void {
	expect(harness.embeddedTexts.length).toBeGreaterThan(1);
	expect(harness.savedFragments).toHaveLength(harness.embeddedTexts.length);
	for (const text of harness.embeddedTexts) {
		expect(text.length).toBeLessThanOrEqual(
			CANONICAL_EMBEDDING_MAX_INPUT_CODE_UNITS,
		);
		expect(prepareCanonicalEmbeddingInput(text)).toBe(text);
	}
	expect(harness.savedFragments.map(fragmentPosition)).toEqual(
		harness.savedFragments.map((_, index) => index),
	);
	expect(
		new Set(harness.savedFragments.map((fragment) => fragment.id)).size,
	).toBe(harness.savedFragments.length);
	expect(
		harness.savedFragments.map((fragment) => fragment.content.text),
	).toEqual(harness.embeddedTexts);
}

function expectAdjacentMarkerOverlap(
	fragments: string[],
	markers: string[],
): void {
	for (let index = 1; index < fragments.length; index += 1) {
		const previous = fragments[index - 1] ?? "";
		const current = fragments[index] ?? "";
		expect(
			markers.some(
				(marker) => previous.includes(marker) && current.includes(marker),
			),
		).toBe(true);
	}
}

describe("document canonical embedding fragmentation", () => {
	it("bounds default token-sized chunks without dropping ordered emoji markers", async () => {
		const markers = Array.from(
			{ length: 420 },
			(_, index) => `marker-${index.toString().padStart(3, "0")}-😀`,
		);
		const documentText = markers.join(" ");
		const harness = makeHarness();

		await expect(
			processFragmentsSynchronously({
				runtime: harness.runtime,
				documentId: DOCUMENT_ID,
				fullDocumentText: documentText,
				agentId: MOCK_AGENT_ID,
			}),
		).resolves.toBeGreaterThan(1);

		expectCanonicalOrderedFragments(harness);
		let previousFirstFragment = 0;
		for (const marker of markers) {
			const firstFragment = harness.embeddedTexts.findIndex((text) =>
				text.includes(marker),
			);
			expect(firstFragment).toBeGreaterThanOrEqual(previousFirstFragment);
			previousFirstFragment = firstFragment;
		}
		expectAdjacentMarkerOverlap(harness.embeddedTexts, markers);
	});

	it("re-splits contextualized output over 510 with monotonic positions", async () => {
		const contextMarkers = Array.from(
			{ length: 180 },
			(_, index) => `context-${index.toString().padStart(3, "0")}-🧭`,
		);
		const generatedContext = contextMarkers.join("|");
		const harness = makeHarness({ contextualize: true, generatedContext });

		await expect(
			processFragmentsSynchronously({
				runtime: harness.runtime,
				documentId: DOCUMENT_ID,
				fullDocumentText: "A short source chunk that receives long context.",
				agentId: MOCK_AGENT_ID,
			}),
		).resolves.toBeGreaterThan(1);

		expectCanonicalOrderedFragments(harness);
		for (const marker of contextMarkers) {
			expect(harness.embeddedTexts.some((text) => text.includes(marker))).toBe(
				true,
			);
		}
		expectAdjacentMarkerOverlap(harness.embeddedTexts, contextMarkers);
	});

	it("rejects a lone surrogate before any document embedding dispatch", async () => {
		const harness = makeHarness();

		await expect(
			processFragmentsSynchronously({
				runtime: harness.runtime,
				documentId: DOCUMENT_ID,
				fullDocumentText: `valid prefix ${"\uD83D"} invalid suffix`,
				agentId: MOCK_AGENT_ID,
			}),
		).rejects.toThrow(/well-formed Unicode/i);
		expect(harness.embeddedTexts).toEqual([]);
		expect(harness.savedFragments).toEqual([]);
	});

	it("fails closed instead of splitting an oversized anchored fragment", async () => {
		let embeddingCalls = 0;
		const runtime = createMockRuntime({
			getModel: (modelType: string) =>
				modelType === ModelType.TEXT_EMBEDDING
					? async () => canonicalTestEmbedding()
					: undefined,
			redactSecrets: (text: string) => text,
			addEmbeddingToMemory: async (memory: Memory) => {
				embeddingCalls += 1;
				return memory;
			},
		});

		await expect(
			preparePreChunkedFragmentMemories({
				runtime,
				documentId: DOCUMENT_ID,
				fragments: [
					{
						text: "x".repeat(CANONICAL_EMBEDDING_MAX_INPUT_CODE_UNITS + 1),
						metadata: {
							segmentIds: ["anchored-segment"],
							startMs: 0,
							endMs: 1_000,
						},
					},
				],
				agentId: MOCK_AGENT_ID,
				roomId: MOCK_AGENT_ID,
				entityId: MOCK_AGENT_ID,
				worldId: MOCK_AGENT_ID,
			}),
		).rejects.toMatchObject({
			code: "DOCUMENT_FRAGMENT_EMBED_FAILED",
			context: { documentId: DOCUMENT_ID, position: 0 },
		});
		expect(embeddingCalls).toBe(0);
	});
});
