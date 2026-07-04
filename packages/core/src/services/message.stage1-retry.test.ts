/**
 * Exercises the Stage-1 retry policy (shouldRetryStage1Generation and
 * getStage1RetryReason). A "malformed HANDLE_RESPONSE tool call" caused by a
 * completion-cap truncation must NOT be retried — regenerating at the same token
 * cap truncates again, burning full Stage-1 turns for the same result (a +12-16s
 * tail-latency spike on direct/DM chat); truncation is routed to the dedicated
 * recovery path instead. Empty or garbled output that did not hit the cap is
 * still worth one retry.
 */
import { describe, expect, it } from "vitest";
import { HANDLE_RESPONSE_TOOL_NAME } from "../actions/to-tool";
import type { GenerateTextResult } from "../types/index";
import { getStage1RetryReason, shouldRetryStage1Generation } from "./message";

function rawWith(opts: {
	finishReason?: string;
	completionTokens?: number;
}): GenerateTextResult {
	return {
		finishReason: opts.finishReason,
		usage:
			opts.completionTokens === undefined
				? undefined
				: { completionTokens: opts.completionTokens },
	} as unknown as GenerateTextResult;
}

describe("shouldRetryStage1Generation", () => {
	const MAX = 1024;

	it("does not retry when there is no retry reason", () => {
		expect(
			shouldRetryStage1Generation(null, rawWith({ completionTokens: 50 }), MAX),
		).toBe(false);
	});

	it("retries an empty completion that did not hit the token cap", () => {
		expect(
			shouldRetryStage1Generation(
				"empty completion",
				rawWith({ completionTokens: 0 }),
				MAX,
			),
		).toBe(true);
	});

	it("does NOT retry a malformed tool call truncated at the token cap", () => {
		// completionTokens >= maxTokens => truncation; a redo truncates identically.
		expect(
			shouldRetryStage1Generation(
				"malformed HANDLE_RESPONSE tool call",
				rawWith({ completionTokens: MAX }),
				MAX,
			),
		).toBe(false);
	});

	it("does NOT retry a malformed tool call with a length finish reason", () => {
		expect(
			shouldRetryStage1Generation(
				"malformed HANDLE_RESPONSE tool call",
				rawWith({ finishReason: "length" }),
				MAX,
			),
		).toBe(false);
	});

	it("retries a malformed tool call that did not hit the token cap", () => {
		// Genuinely garbled (not truncated) output may recover on a fresh attempt.
		expect(
			shouldRetryStage1Generation(
				"malformed HANDLE_RESPONSE tool call",
				rawWith({ finishReason: "stop", completionTokens: 40 }),
				MAX,
			),
		).toBe(true);
	});

	it("retries a string completion (which can never be a cap truncation)", () => {
		expect(
			shouldRetryStage1Generation(
				"malformed HANDLE_RESPONSE tool call",
				"some non-empty text",
				MAX,
			),
		).toBe(true);
	});

	it("retries one token under the cap (the boundary the whole guard turns on)", () => {
		// completionTokens < maxTokens is NOT a truncation: the output stopped on
		// its own, so a fresh attempt can still fix genuinely-garbled args.
		expect(
			shouldRetryStage1Generation(
				"malformed HANDLE_RESPONSE tool call",
				rawWith({ completionTokens: MAX - 1 }),
				MAX,
			),
		).toBe(true);
	});

	it("treats the max-token finish-reason aliases as truncation", () => {
		// Providers report the cap differently (max_tokens / token-limit /
		// output_limit); the finish-reason match must catch these aliases, not just
		// the literal "length". An unenumerated reason (e.g. "content_filter") is
		// NOT a cap hit and would still retry.
		for (const finishReason of ["max_tokens", "token-limit", "output_limit"]) {
			expect(
				shouldRetryStage1Generation(
					"malformed HANDLE_RESPONSE tool call",
					rawWith({ finishReason }),
					MAX,
				),
			).toBe(false);
		}
	});

	it("with no cap (direct channel) detects truncation by finishReason only", () => {
		// Direct-channel Stage-1 sends no max-tokens cap, so maxTokens is undefined.
		// A huge completion count is NOT a truncation (no cap to hit) → still retry a
		// garbled result; only a length-style finishReason blocks the retry.
		expect(
			shouldRetryStage1Generation(
				"malformed HANDLE_RESPONSE tool call",
				rawWith({ completionTokens: 1_000_000 }),
				undefined,
			),
		).toBe(true);
		expect(
			shouldRetryStage1Generation(
				"malformed HANDLE_RESPONSE tool call",
				rawWith({ finishReason: "length" }),
				undefined,
			),
		).toBe(false);
	});
});

function toolCallResult(args: string): GenerateTextResult {
	return {
		toolCalls: [{ name: HANDLE_RESPONSE_TOOL_NAME, arguments: args }],
	} as unknown as GenerateTextResult;
}

describe("getStage1RetryReason duplicate tool-call recovery", () => {
	it("recovers identical double-emitted HANDLE_RESPONSE args", () => {
		expect(
			getStage1RetryReason(
				toolCallResult('{"replyText":"hi"}{"replyText":"hi"}'),
			),
		).toBeNull();
	});

	it("still parses normal single-object HANDLE_RESPONSE args", () => {
		expect(
			getStage1RetryReason(toolCallResult('{"replyText":"hi"}')),
		).toBeNull();
	});

	it("rejects conflicting double-emitted HANDLE_RESPONSE args", () => {
		expect(
			getStage1RetryReason(
				toolCallResult('{"replyText":"hi"}{"replyText":"bye"}'),
			),
		).toBe("malformed HANDLE_RESPONSE tool call");
	});

	it("rejects arrays, primitives, and prose-embedded objects as tool args", () => {
		for (const args of [
			'["not","an","object"]',
			'"not an object"',
			'model said {"replyText":"hi"}',
		]) {
			expect(getStage1RetryReason(toolCallResult(args))).toBe(
				"malformed HANDLE_RESPONSE tool call",
			);
		}
	});

	it("still flags an empty completion", () => {
		expect(getStage1RetryReason("")).toBe("empty completion");
	});
});
