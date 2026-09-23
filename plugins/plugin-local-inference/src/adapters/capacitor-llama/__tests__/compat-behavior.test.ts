/**
 * Behavioral tests for the Capacitor-llama `local-ai` plugin's model handlers.
 * The loader is mocked and a hand-built `CapacitorLlamaContext` fake drives
 * completion/streaming, so the handler wiring — not a real native model — is
 * under test. Each case owns a fresh manager; retry and sharing assertions use
 * repeated calls within that case.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { getEmbeddingVectorSpace, ModelType } from "@elizaos/core";
import { prepareBgeEmbeddingInput } from "@elizaos/shared/local-inference/bge-input";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type {
	CapacitorLlamaCompletionParams,
	CapacitorLlamaCompletionResult,
	CapacitorLlamaContext,
	CapacitorLlamaTokenData,
} from "../types";

const mocks = vi.hoisted(() => ({
	initCapacitorLlama: vi.fn(),
	initMobileBgeEmbedding: vi.fn(),
	verifyBgeEmbeddingFile: vi.fn(
		() => "BAAI/bge-small-en-v1.5:cls:l2:384:hf-bert-v1:tail-v1",
	),
}));

vi.mock("../..", () => ({
	createLocalInferenceModelHandlers: vi.fn(() => ({})),
	isLocalInferenceUnavailableError: vi.fn(() => false),
}));

vi.mock("../loader", () => ({
	initCapacitorLlama: mocks.initCapacitorLlama,
	initMobileBgeEmbedding: mocks.initMobileBgeEmbedding,
}));

const testDir = mkdtempSync(join(tmpdir(), "eliza-capacitor-compat-"));
let localAiPlugin: typeof import("../index")["localAiPlugin"];

afterAll(() => rmSync(testDir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());
vi.mock("../../../runtime/embedding-vector-space", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("../../../runtime/embedding-vector-space")
		>();
	return { ...original, verifyBgeEmbeddingFile: mocks.verifyBgeEmbeddingFile };
});

let corruptEmbeddingTokenizer = false;
let corruptEmbeddingOutputTokens = false;
const embeddingInputs: string[] = [];

let observedCompletion:
	| ((params: CapacitorLlamaCompletionParams) => void)
	| undefined;
let completionResultOverrides: Partial<CapacitorLlamaCompletionResult> = {};

function makeCompletionResult(
	text: string,
	overrides: Partial<CapacitorLlamaCompletionResult> = {},
): CapacitorLlamaCompletionResult {
	return {
		text,
		content: text,
		reasoning_content: "",
		tool_calls: [],
		chat_format: 0,
		tokens_predicted: 2,
		tokens_evaluated: 3,
		truncated: false,
		stopped_eos: true,
		stopped_word: "",
		stopped_limit: 0,
		stopping_word: "",
		context_full: false,
		interrupted: false,
		tokens_cached: 0,
		timings: {
			prompt_n: 0,
			prompt_ms: 0,
			prompt_per_token_ms: 0,
			prompt_per_second: 0,
			predicted_n: 2,
			predicted_ms: 0,
			predicted_per_token_ms: 0,
			predicted_per_second: 0,
		},
		...overrides,
	};
}

function makeCtx(): CapacitorLlamaContext {
	return {
		id: 1,
		gpu: false,
		reasonNoGPU: "",
		model: {} as CapacitorLlamaContext["model"],
		async completion(
			params: CapacitorLlamaCompletionParams,
			callback?: (data: CapacitorLlamaTokenData) => void,
		): Promise<CapacitorLlamaCompletionResult> {
			observedCompletion?.(params);
			callback?.({ token: "hel" });
			callback?.({ token: "lo" });
			return makeCompletionResult("hello", completionResultOverrides);
		},
		stopCompletion: vi.fn(async () => undefined),
		tokenize: vi.fn(async (text: string) => ({
			tokens: corruptEmbeddingTokenizer
				? [101, 999, 102]
				: prepareBgeEmbeddingInput(text).tokenIds,
			has_images: false,
			bitmap_hashes: [],
			chunk_pos: [],
			chunk_pos_images: [],
		})),
		detokenize: vi.fn(async () => ""),
		embedding: vi.fn(async (text: string) => {
			embeddingInputs.push(text);
			const tokenIds = [...prepareBgeEmbeddingInput(text).tokenIds];
			if (corruptEmbeddingOutputTokens) tokenIds[1] = 999;
			return {
				embedding: [3, 4, ...Array.from({ length: 382 }, () => 0)],
				tokenIds,
				tokens: tokenIds.length,
				embeddingSpace: "BAAI/bge-small-en-v1.5:cls:l2:384:hf-bert-v1:tail-v1",
			};
		}),
		bench: vi.fn(async () => ({
			modelDesc: "",
			modelSize: 0,
			modelNParams: 0,
			ppAvg: 0,
			ppStd: 0,
			tgAvg: 0,
			tgStd: 0,
		})),
		release: vi.fn(async () => undefined),
	};
}

function makeRuntime(): IAgentRuntime {
	return {
		getSetting: vi.fn(() => undefined),
		emitEvent: vi.fn(async () => undefined),
	} as unknown as IAgentRuntime;
}

describe("local-ai compat adapter behavior", () => {
	beforeEach(async () => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.stubEnv("CACHE_DIR", join(testDir, "cache"));
		vi.stubEnv("MODELS_DIR", join(testDir, "models"));
		corruptEmbeddingTokenizer = false;
		corruptEmbeddingOutputTokens = false;
		embeddingInputs.length = 0;
		observedCompletion = undefined;
		completionResultOverrides = {};
		mocks.initCapacitorLlama
			.mockReset()
			.mockImplementation(async () => makeCtx());
		mocks.initMobileBgeEmbedding
			.mockReset()
			.mockImplementation(async () => makeCtx());
		({ localAiPlugin } = await import("../index"));
	});

	it.each([null, "", "   ", { text: "" }, { text: "   " }])(
		"rejects empty embedding input %# instead of returning a fake vector",
		async (params) => {
			await expect(
				localAiPlugin.models?.[ModelType.TEXT_EMBEDDING]?.(
					makeRuntime(),
					params as never,
				),
			).rejects.toThrow("Embedding text must be a non-empty string");
		},
	);

	it("rejects an unverified artifact before loading native code and permits retry", async () => {
		const failure = new Error("artifact integrity check failed");
		mocks.verifyBgeEmbeddingFile.mockImplementationOnce(() => {
			throw failure;
		});
		await expect(
			localAiPlugin.models?.[ModelType.TEXT_EMBEDDING]?.(makeRuntime(), {
				text: "verify this model first",
			} as never),
		).rejects.toBe(failure);
		expect(mocks.initCapacitorLlama).not.toHaveBeenCalled();
		expect(mocks.initMobileBgeEmbedding).not.toHaveBeenCalled();
		expect(embeddingInputs).toEqual([]);
		await expect(
			localAiPlugin.models?.[ModelType.TEXT_EMBEDDING]?.(makeRuntime(), {
				text: "retry with a verified artifact",
			} as never),
		).resolves.toHaveLength(384);
		expect(embeddingInputs).toEqual(["retry with a verified artifact"]);
	});

	it("propagates native startup failure without caching a broken context", async () => {
		const failure = new Error("native allocation failed");
		mocks.initMobileBgeEmbedding.mockRejectedValueOnce(failure);
		await expect(
			localAiPlugin.models?.[ModelType.TEXT_EMBEDDING]?.(makeRuntime(), {
				text: "retry after startup failure",
			} as never),
		).rejects.toBe(failure);
		expect(embeddingInputs).toEqual([]);
		await expect(
			localAiPlugin.models?.[ModelType.TEXT_EMBEDDING]?.(makeRuntime(), {
				text: "retry with a working native context",
			} as never),
		).resolves.toHaveLength(384);
		expect(embeddingInputs).toEqual(["retry with a working native context"]);
	});

	it("routes concurrent embedding input to one dedicated embedding context", async () => {
		const [result, concurrent] = await Promise.all([
			localAiPlugin.models?.[ModelType.TEXT_EMBEDDING]?.(makeRuntime(), {
				text: "embed me",
			} as never),
			localAiPlugin.models?.[ModelType.TEXT_EMBEDDING]?.(makeRuntime(), {
				text: "concurrent complete input",
			} as never),
		]);
		expect(concurrent).toEqual(result);
		expect(mocks.initMobileBgeEmbedding).toHaveBeenCalledTimes(1);
		expect(mocks.initCapacitorLlama).not.toHaveBeenCalled();

		expect(result).toEqual([0.6, 0.8, ...Array.from({ length: 382 }, () => 0)]);
		expect(getEmbeddingVectorSpace(result)).toBe(
			"BAAI/bge-small-en-v1.5:cls:l2:384:hf-bert-v1:tail-v1",
		);
		expect(mocks.verifyBgeEmbeddingFile).toHaveBeenCalledWith(
			expect.stringContaining("bge-small-en-v1.5-f16.gguf"),
		);
		expect(mocks.initMobileBgeEmbedding).toHaveBeenCalledWith(
			expect.stringContaining("bge-small-en-v1.5-f16.gguf"),
			512,
		);
		expect(embeddingInputs).toEqual(["embed me", "concurrent complete input"]);
	});

	it("rejects a native tokenizer mismatch before embedding dispatch", async () => {
		corruptEmbeddingTokenizer = true;
		await expect(
			localAiPlugin.models?.[ModelType.TEXT_EMBEDDING]?.(makeRuntime(), {
				text: "complete input with final tail",
			} as never),
		).rejects.toMatchObject({ code: "EMBEDDING_TOKENIZER_MISMATCH" });
		expect(embeddingInputs).toEqual([]);
	});

	it("retains the final source words before invoking the native mobile bridge", async () => {
		const tail = `${"word ".repeat(508)}last instruction`;
		await localAiPlugin.models?.[ModelType.TEXT_EMBEDDING]?.(makeRuntime(), {
			text: `obsolete ${tail}`,
		} as never);
		expect(embeddingInputs).toEqual([tail]);
	});

	it("rejects returned token disagreement after a matching native preflight", async () => {
		corruptEmbeddingOutputTokens = true;
		const text = "complete source with a verified ending";
		await expect(
			localAiPlugin.models?.[ModelType.TEXT_EMBEDDING]?.(makeRuntime(), {
				text,
			} as never),
		).rejects.toMatchObject({ code: "EMBEDDING_TOKENIZER_MISMATCH" });
		expect(embeddingInputs).toEqual([text]);
	});

	it("dispatches the complete boundary-sized text", async () => {
		const text = "word ".repeat(510);
		await localAiPlugin.models?.[ModelType.TEXT_EMBEDDING]?.(makeRuntime(), {
			text,
		} as never);
		expect(embeddingInputs).toEqual([text]);
	});

	it("wires onStreamChunk through the compat text adapter", async () => {
		const onStreamChunk = vi.fn();

		const result = await localAiPlugin.models?.[ModelType.TEXT_SMALL]?.(
			makeRuntime(),
			{
				prompt: "stream this",
				stream: true,
				onStreamChunk,
			} as never,
		);

		for await (const _chunk of result.textStream) {
			// drain
		}

		expect(onStreamChunk).toHaveBeenCalled();
		expect(onStreamChunk.mock.calls.map(([chunk]) => chunk).join("")).toBe(
			"hello",
		);

		// The native load must use mmap and windowed KV to fit mobile memory.
		expect(mocks.initCapacitorLlama).toHaveBeenCalled();
		const initParams = mocks.initCapacitorLlama.mock.calls[0]?.[0] as {
			use_mmap?: boolean;
			swa_full?: boolean;
		};
		expect(initParams.use_mmap).toBe(true);
		expect(initParams.swa_full).toBe(false);
	});

	it("sends a desktop-safe prompt and forwards sampler controls", async () => {
		let completionParams: CapacitorLlamaCompletionParams | undefined;
		observedCompletion = (params) => {
			completionParams = params;
		};

		await localAiPlugin.models?.[ModelType.TEXT_SMALL]?.(makeRuntime(), {
			system: "system prompt",
			prompt: "user prompt",
			maxTokens: 42,
			temperature: 0.2,
			topP: 0.8,
			topK: 17,
			minP: 0.05,
			seed: 1234,
			repetitionPenalty: 1.05,
			frequencyPenalty: 0.3,
			presencePenalty: 0.4,
			stopSequences: ["</s>"],
		} as never);

		expect(completionParams?.prompt).toContain("system: system prompt");
		expect(completionParams?.prompt).toContain("user: user prompt");
		expect(completionParams?.messages).toBeUndefined();
		expect(completionParams).toMatchObject({
			n_predict: 42,
			temperature: 0.2,
			top_p: 0.8,
			top_k: 17,
			min_p: 0.05,
			seed: 1234,
			penalty_repeat: 1.05,
			penalty_freq: 0.3,
			penalty_present: 0.4,
			stop: ["</s>"],
		});
	});

	it("omits the generation ceiling when the caller did not request one", async () => {
		let completionParams: CapacitorLlamaCompletionParams | undefined;
		observedCompletion = (params) => {
			completionParams = params;
		};

		await localAiPlugin.models?.[ModelType.TEXT_SMALL]?.(makeRuntime(), {
			prompt: "complete this response",
		} as never);

		expect(completionParams).not.toHaveProperty("n_predict");
	});

	it.each([
		{ truncated: true },
		{ stopped_limit: 1 },
		{ context_full: true },
		{ interrupted: true },
	])("rejects incomplete native output %#", async (completionOverrides) => {
		completionResultOverrides = {
			stopped_eos: false,
			...completionOverrides,
		};

		await expect(
			localAiPlugin.models?.[ModelType.TEXT_SMALL]?.(makeRuntime(), {
				prompt: "do not return a partial response",
			} as never),
		).rejects.toMatchObject({ code: "LOCAL_INFERENCE_INCOMPLETE_OUTPUT" });
	});

	it("preserves function toolChoice objects as a Capacitor tool_choice", async () => {
		let completionParams: CapacitorLlamaCompletionParams | undefined;
		observedCompletion = (params) => {
			completionParams = params;
		};

		await localAiPlugin.models?.[ModelType.TEXT_SMALL]?.(makeRuntime(), {
			prompt: "use tool",
			tools: [{ name: "lookup" }],
			toolChoice: { type: "function", function: { name: "lookup" } },
		} as never);

		expect(completionParams?.tool_choice).toBe("lookup");
	});
});
