/**
 * Exercises the depth/node bound on canonicalJsonValue via the real exported
 * Stage-1 entry point (getStage1RetryReason). Reproduces #23837: a duplicated
 * tool-argument stream nested (or widened) past the walk's bound must
 * classify as a malformed tool call instead of throwing RangeError and
 * killing the turn.
 */
import { describe, expect, it } from "vitest";
import { HANDLE_RESPONSE_TOOL_NAME } from "../actions/to-tool";
import type { GenerateTextResult } from "../types/index";
import { getStage1RetryReason } from "./message";

function toolCallResult(args: string): GenerateTextResult {
	return {
		toolCalls: [{ name: HANDLE_RESPONSE_TOOL_NAME, arguments: args }],
	} as unknown as GenerateTextResult;
}

// canonicalJsonValue is only reachable once the parsed object already "looks
// like" HANDLE_RESPONSE tool arguments (looksLikeMessageHandlerToolArguments
// requires a recognized top-level key), so every fixture nests its payload
// under replyText rather than at the object root.
function nestedReplyText(depth: number): string {
	let inner = "{}";
	for (let i = 0; i < depth; i++) {
		inner = `{"a":${inner}}`;
	}
	return `{"replyText":${inner}}`;
}

function wideReplyText(keys: number): string {
	const entries = Array.from({ length: keys }, (_, i) => `"k${i}":${i}`).join(
		",",
	);
	return `{"replyText":{${entries}}}`;
}

describe("canonicalJsonValue bound (#23837)", () => {
	it("classifies an over-depth duplicated tool-call stream as malformed instead of throwing", () => {
		const deep = nestedReplyText(5_000);
		expect(() =>
			getStage1RetryReason(toolCallResult(`${deep}${deep}`)),
		).not.toThrow();
		expect(getStage1RetryReason(toolCallResult(`${deep}${deep}`))).toBe(
			"malformed HANDLE_RESPONSE tool call",
		);
	});

	it("classifies an over-node-budget duplicated tool-call stream as malformed instead of throwing", () => {
		const wide = wideReplyText(10_000);
		expect(() =>
			getStage1RetryReason(toolCallResult(`${wide}${wide}`)),
		).not.toThrow();
		expect(getStage1RetryReason(toolCallResult(`${wide}${wide}`))).toBe(
			"malformed HANDLE_RESPONSE tool call",
		);
	});

	it("still recovers an identical duplicated stream well within the bound", () => {
		const shallow = nestedReplyText(5);
		expect(
			getStage1RetryReason(toolCallResult(`${shallow}${shallow}`)),
		).toBeNull();
	});
});
