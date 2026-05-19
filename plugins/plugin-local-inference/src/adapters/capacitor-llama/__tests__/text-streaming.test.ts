import type { TokenUsage } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { streamCapacitorPrompt } from "../text-streaming";
import type {
	CapacitorLlamaCompletionParams,
	CapacitorLlamaCompletionResult,
	CapacitorLlamaContext,
	CapacitorLlamaTokenData,
} from "../types";

function makeBaseResult(
	text: string,
	overrides: Partial<CapacitorLlamaCompletionResult> = {},
): CapacitorLlamaCompletionResult {
	return {
		text,
		reasoning_content: "",
		tool_calls: [],
		content: text,
		chat_format: 0,
		tokens_predicted: 4,
		tokens_evaluated: 3,
		truncated: false,
		stopped_eos: true,
		stopped_word: "",
		stopped_limit: 0,
		stopping_word: "",
		context_full: false,
		interrupted: false,
		tokens_cached: 3,
		timings: {
			prompt_n: 0,
			prompt_ms: 0,
			prompt_per_token_ms: 0,
			prompt_per_second: 0,
			predicted_n: 4,
			predicted_ms: 10,
			predicted_per_token_ms: 2.5,
			predicted_per_second: 400,
		},
		...overrides,
	};
}

function makeCtx(
	chunks: string[],
	overrides: Partial<CapacitorLlamaCompletionResult> = {},
): CapacitorLlamaContext {
	return {
		id: 1,
		gpu: false,
		reasonNoGPU: "",
		model: {} as CapacitorLlamaContext["model"],
		async completion(
			_params: CapacitorLlamaCompletionParams,
			callback?: (data: CapacitorLlamaTokenData) => void,
		): Promise<CapacitorLlamaCompletionResult> {
			for (const chunk of chunks) {
				callback?.({ token: chunk });
			}
			return makeBaseResult(chunks.join(""), overrides);
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
		embedding: vi.fn(async () => ({ embedding: [] })),
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

const estimateUsage = (prompt: string, fullText: string): TokenUsage => ({
	promptTokens: prompt.length,
	completionTokens: fullText.length,
	totalTokens: prompt.length + fullText.length,
});

describe("capacitor-llama / text-streaming", () => {
	it("forwards each token through textStream", async () => {
		const ctx = makeCtx(["hel", "lo", " ", "world"]);
		const stream = streamCapacitorPrompt({
			ctx,
			params: { prompt: "hi" },
			estimateUsage,
		});
		const collected: string[] = [];
		for await (const chunk of stream.textStream) {
			collected.push(chunk);
		}
		expect(collected.join("")).toBe("hello world");
		const fullText = await stream.text;
		expect(fullText).toBe("hello world");
		const usage = await stream.usage;
		expect(usage?.promptTokens).toBe(3);
		expect(usage?.completionTokens).toBe(4);
	});

	it("strips think tags via postProcess on the resolved text", async () => {
		const ctx = makeCtx(["<think>secret</think>", "answer"]);
		const stream = streamCapacitorPrompt({
			ctx,
			params: { prompt: "hi" },
			estimateUsage,
			postProcess: (raw) => raw.replace(/<think>[\s\S]*?<\/think>\n?/g, ""),
		});
		// Drain the iterable.
		for await (const _ of stream.textStream) {
			// nothing
		}
		const final = await stream.text;
		expect(final).toBe("answer");
	});

	it("resolves finishReason to stop on stopped_eos", async () => {
		const ctx = makeCtx(["a", "b"]);
		const stream = streamCapacitorPrompt({
			ctx,
			params: { prompt: "hi" },
			estimateUsage,
		});
		for await (const _ of stream.textStream) {
			/* drain */
		}
		expect(await stream.finishReason).toBe("stop");
	});

	it("resolves finishReason to length on stopped_limit", async () => {
		const ctx = makeCtx(["a"], { stopped_eos: false, stopped_limit: 1 });
		const stream = streamCapacitorPrompt({
			ctx,
			params: { prompt: "hi" },
			estimateUsage,
		});
		for await (const _ of stream.textStream) {
			/* drain */
		}
		expect(await stream.finishReason).toBe("length");
	});

	it("invokes onChunk with every visible delta and the concatenation matches the full text", async () => {
		const seen: string[] = [];
		const ctx = makeCtx(["a", "bc"]);
		const stream = streamCapacitorPrompt({
			ctx,
			params: { prompt: "hi" },
			estimateUsage,
			onChunk: (delta) => {
				seen.push(delta);
			},
		});
		for await (const _ of stream.textStream) {
			/* drain */
		}
		// The think-tag filter coalesces tokens during buffering to keep
		// `<think>` prefix detection safe. We don't assert chunk boundaries —
		// only that every visible byte was delivered exactly once.
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.join("")).toBe("abc");
	});
});
