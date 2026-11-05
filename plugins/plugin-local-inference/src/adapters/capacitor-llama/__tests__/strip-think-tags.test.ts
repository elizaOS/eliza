/**
 * Equivalence tests for the completed-text think-tag stripper.
 *
 * The same completion reaches the caller twice: as a token stream filtered
 * by the think-tag stream filter in text-streaming.ts, and as completed
 * text post-processed by `stripThinkTags`. Both paths must produce the
 * same visible text for the same input, so each case runs the input
 * through both and compares the results.
 */

import { describe, expect, it } from "vitest";
import { stripThinkTags } from "../index";
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

async function collectStreamed(input: string): Promise<string> {
	const completion = async (
		_params: CapacitorLlamaCompletionParams,
		callback?: (data: CapacitorLlamaTokenData) => void,
	): Promise<CapacitorLlamaCompletionResult> => {
		callback?.({ token: input });
		return makeCompletionResult(input);
	};
	const ctx = { completion } as unknown as CapacitorLlamaContext;
	const result = streamCapacitorPrompt({
		ctx,
		params: { prompt: "p" },
		estimateUsage: () => ({
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
		}),
	});
	let streamed = "";
	for await (const chunk of result.textStream) streamed += chunk;
	return streamed;
}

describe("stripThinkTags matches the stream filter", () => {
	it.each([
		// A closed pair is removed; the newline after it is kept.
		"<think>hidden</think>\nshown",
		// Uppercase markers form a block too.
		"secret <THINK>hidden</THINK> answer",
		// An unclosed block is dropped to the end of the text.
		"keep <think>hidden",
		// Attribute-style open tags form a block.
		'<think foo="bar">hidden</think>shown',
		// Tags that merely start with "<think" are not reasoning blocks:
		// the stream filter emits them in full, so the stripper must too.
		"Wrap reasoning in <thinking> tags, e.g. <thinking>example</thinking> done",
		"<thinkpad>Lenovo</thinkpad>",
		"a <think-foo> b",
		"<think/>self-closing",
		// A trailing bare "<think" has no boundary character, so the stream
		// filter emits it at flush; a trailing "<think " does open a block
		// and is dropped.
		"trailing <think",
		"trailing <think ",
		// A stray close marker is plain text on both paths.
		"stray </think> marker",
		// Two blocks in one completion.
		"multi <think>a</think> mid <think>b</think> end",
	])("%j", async (input) => {
		expect(stripThinkTags(input)).toBe(await collectStreamed(input));
	});
});
