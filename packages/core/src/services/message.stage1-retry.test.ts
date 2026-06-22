import { describe, expect, it } from "vitest";
import type { GenerateTextResult } from "../types/index";
import { shouldRetryStage1Generation } from "./message";

/**
 * Stage-1 retry policy (latency fix): a "malformed HANDLE_RESPONSE tool call"
 * caused by a completion-limit truncation must NOT be retried — regenerating at
 * the same token cap truncates again, burning full Stage-1 turns for the same
 * result (the measured +12-16s tail-latency spike on direct/DM chat). Truncation
 * is routed to the dedicated recovery path instead. Empty/garbled output that did
 * not hit the cap is still worth one retry.
 */
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
});
