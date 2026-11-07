/**
 * Behavioral tests for the Capacitor streaming bridge's `<think>` filter.
 * A fake `CapacitorLlamaContext` pushes the given token pieces through the
 * completion callback, so tag detection across chunk boundaries is exercised
 * exactly as the native binding would drive it.
 */

import { describe, expect, it } from "vitest";
import { streamCapacitorPrompt } from "../text-streaming";
import type {
	CapacitorLlamaCompletionParams,
	CapacitorLlamaCompletionResult,
	CapacitorLlamaContext,
	CapacitorLlamaTokenData,
} from "../types";

function makeCompletionResult(text: string): CapacitorLlamaCompletionResult {
	return {
		text,
		content: text,
		reasoning_content: "",
		tool_calls: [],
		chat_format: 0,
		tokens_predicted: 1,
		tokens_evaluated: 1,
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
			predicted_n: 1,
			predicted_ms: 0,
			predicted_per_token_ms: 0,
			predicted_per_second: 0,
		},
	};
}

function makeCtx(pieces: string[]): CapacitorLlamaContext {
	const completion = async (
		_params: CapacitorLlamaCompletionParams,
		callback?: (data: CapacitorLlamaTokenData) => void,
	): Promise<CapacitorLlamaCompletionResult> => {
		for (const token of pieces) callback?.({ token });
		return makeCompletionResult(pieces.join(""));
	};
	return { completion } as unknown as CapacitorLlamaContext;
}

async function collectStream(
	pieces: string[],
): Promise<{ streamed: string; text: string }> {
	const result = streamCapacitorPrompt({
		ctx: makeCtx(pieces),
		params: { prompt: "p" },
		estimateUsage: () => ({
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
		}),
	});
	let streamed = "";
	for await (const chunk of result.textStream) streamed += chunk;
	return { streamed, text: await result.text };
}

describe("streamCapacitorPrompt think-tag filter", () => {
	it("does not treat tags that merely start with <think as reasoning", async () => {
		const { streamed, text } = await collectStream([
			"<thinkpad>Lenovo</thinkpad>",
		]);
		expect(streamed).toBe("<thinkpad>Lenovo</thinkpad>");
		expect(streamed).toBe(text);
	});

	it("keeps <thinkpad> text when the tag name is split across chunks", async () => {
		const { streamed } = await collectStream(["a<think", "pad>b"]);
		expect(streamed).toBe("a<thinkpad>b");
	});

	it("hides a real <think> block split across chunks", async () => {
		expect(
			(await collectStream(["<thin", "k", ">secret</think>", "answer"]))
				.streamed,
		).toBe("answer");
		expect((await collectStream(["<think", ">s</think>ok"])).streamed).toBe(
			"ok",
		);
	});

	it("accepts whitespace as the tag boundary", async () => {
		expect((await collectStream(["<think\n>x</think>y"])).streamed).toBe("y");
	});
});
