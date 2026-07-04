/**
 * Behavioral tests for the Capacitor-llama `local-ai` plugin's model handlers.
 * The loader is mocked and a hand-built `CapacitorLlamaContext` fake drives
 * completion/streaming, so the handler wiring — not a real native model — is
 * under test.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CapacitorLlamaCompletionParams,
	CapacitorLlamaCompletionResult,
	CapacitorLlamaContext,
	CapacitorLlamaTokenData,
} from "../types";

const mocks = vi.hoisted(() => ({
	initCapacitorLlama: vi.fn(),
}));

vi.mock("../..", () => ({
	createLocalInferenceModelHandlers: vi.fn(() => ({})),
	isLocalInferenceUnavailableError: vi.fn(() => false),
}));

vi.mock("../loader", () => ({
	initCapacitorLlama: mocks.initCapacitorLlama,
}));

const { localAiPlugin } = await import("../index");

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

function makeCtx(
	onCompletion?: (params: CapacitorLlamaCompletionParams) => void,
): CapacitorLlamaContext {
	return {
		id: 1,
		gpu: false,
		reasonNoGPU: "",
		model: {} as CapacitorLlamaContext["model"],
		async completion(
			params: CapacitorLlamaCompletionParams,
			callback?: (data: CapacitorLlamaTokenData) => void,
		): Promise<CapacitorLlamaCompletionResult> {
			onCompletion?.(params);
			callback?.({ token: "hel" });
			callback?.({ token: "lo" });
			return makeCompletionResult("hello");
		},
		stopCompletion: vi.fn(async () => undefined),
		tokenize: vi.fn(async () => ({
			tokens: [],
			has_images: false,
			bitmap_hashes: [],
			chunk_pos: [],
			chunk_pos_images: [],
		})),
		detokenize: vi.fn(async () => ""),
		embedding: vi.fn(async (text: string) => ({
			embedding: text === "embed me" ? [0.1, 0.2, 0.3] : [1],
		})),
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
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.initCapacitorLlama.mockImplementation(async () => makeCtx());
	});

	it.each([
		null,
		"",
		"   ",
		{ text: "" },
		{ text: "   " },
	])("rejects empty embedding input %# instead of returning a fake vector", async (params) => {
		await expect(
			localAiPlugin.models?.[ModelType.TEXT_EMBEDDING]?.(
				makeRuntime(),
				params as never,
			),
		).rejects.toThrow("Embedding text must be a non-empty string");
	});

	it("routes non-empty embedding input to the real embedding context", async () => {
		const result = await localAiPlugin.models?.[ModelType.TEXT_EMBEDDING]?.(
			makeRuntime(),
			{ text: "embed me" } as never,
		);

		expect(result).toEqual([0.1, 0.2, 0.3]);
	});

	it("wires onStreamChunk through the compat text adapter", async () => {
		mocks.initCapacitorLlama.mockResolvedValueOnce(makeCtx());
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

		// Gemma-aware RAM defaults (#9033): this is the first text-context load,
		// so the fresh initCapacitorLlama call carries the pinned defaults —
		// mmap on (lever 3: PLE pages from disk) and windowed SWA KV
		// (lever 2: swa_full=false, the dominant KV saving on Gemma-4).
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
		mocks.initCapacitorLlama.mockResolvedValueOnce(
			makeCtx((params) => {
				completionParams = params;
			}),
		);

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

	it("preserves function toolChoice objects as a Capacitor tool_choice", async () => {
		let completionParams: CapacitorLlamaCompletionParams | undefined;
		mocks.initCapacitorLlama.mockResolvedValueOnce(
			makeCtx((params) => {
				completionParams = params;
			}),
		);

		await localAiPlugin.models?.[ModelType.TEXT_SMALL]?.(makeRuntime(), {
			prompt: "use tool",
			tools: [{ name: "lookup" }],
			toolChoice: { type: "function", function: { name: "lookup" } },
		} as never);

		expect(completionParams?.tool_choice).toBe("lookup");
	});
});
