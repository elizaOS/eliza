/**
 * Stage-1 tool-argument parsing is an untrusted-model boundary
 * (`error-policy:J3 planner output is untrusted model input`). A planner that
 * emits the HANDLE_RESPONSE arguments as a duplicated object stream drives the
 * duplicated-stream recovery in `parseToolArgumentsString`, which canonicalizes
 * each recovered fragment before comparing them.
 *
 * That canonicalizer must be bounded, and it must fail rather than truncate:
 *   - an over-nested fragment becomes the documented "malformed" signal so the
 *     Stage-1 recovery chain runs, never a `RangeError` that escapes
 *     `runV5MessageRuntimeStage1` and ends the turn;
 *   - two DIFFERENT over-budget fragments must never compare equal, which is
 *     what a lossy normalizer would produce;
 *   - every stream the live path accepts today still recovers unchanged.
 *
 * `getStage1RetryReason` is the exported Stage-1 entry point that reaches the
 * parser (`message.ts` calls it on the raw completion before parsing), so these
 * assertions run the real production path with no test-only surface.
 */
import { describe, expect, it } from "vitest";
import { HANDLE_RESPONSE_TOOL_NAME } from "../actions/to-tool";
import type { GenerateTextResult } from "../types/index";
import { getStage1RetryReason } from "./message";

function nestedObjectJson(depth: number, leaf = "1"): string {
	return `${'{"a":'.repeat(depth)}${leaf}${"}".repeat(depth)}`;
}

/** A weak model narrating the same tool call twice, as concatenated objects. */
function duplicatedStream(objectText: string): string {
	return `${objectText}${objectText}`;
}

function rawWithToolArguments(argumentsText: string): GenerateTextResult {
	return {
		toolCalls: [{ name: HANDLE_RESPONSE_TOOL_NAME, arguments: argumentsText }],
	} as unknown as GenerateTextResult;
}

/** A realistic HANDLE_RESPONSE arguments object, emitted twice by the model. */
const WELL_FORMED_ARGUMENTS = JSON.stringify({
	shouldRespond: true,
	replyText: "Here is the summary you asked for.",
	thought: "The user wants a recap; answer directly.",
	contexts: [
		{ name: "RECENT_MESSAGES", reason: "transcript" },
		{ name: "ENTITIES", reason: "who is speaking" },
	],
	plan: { reply: "Here is the summary you asked for.", actions: ["REPLY"] },
});

describe("Stage-1 tool-argument canonicalization bounds", () => {
	it("classifies an over-nested duplicated stream instead of overflowing", () => {
		const argumentsText = duplicatedStream(nestedObjectJson(50_000));
		// Well inside an ordinary completion: ~586 KiB of model output.
		expect(argumentsText.length).toBeLessThan(1_000_000);
		expect(getStage1RetryReason(rawWithToolArguments(argumentsText))).toBe(
			"malformed HANDLE_RESPONSE tool call",
		);
	});

	it("does not compare two DIFFERENT over-budget fragments as equal", () => {
		// A lossy normalizer collapses both tails to the same marker and would
		// accept this stream as a repeat of one object. It is not one.
		const argumentsText = `${nestedObjectJson(50_000, '"LEFT"')}${nestedObjectJson(
			50_000,
			'"RIGHT"',
		)}`;
		expect(getStage1RetryReason(rawWithToolArguments(argumentsText))).toBe(
			"malformed HANDLE_RESPONSE tool call",
		);
	});

	it("still recovers an ordinary duplicated HANDLE_RESPONSE stream", () => {
		expect(
			getStage1RetryReason(
				rawWithToolArguments(duplicatedStream(WELL_FORMED_ARGUMENTS)),
			),
		).toBeNull();
	});

	it("still recovers when the repeat differs only in key order", () => {
		const argumentsText = `${JSON.stringify({
			shouldRespond: true,
			replyText: "ok",
		})}${JSON.stringify({ replyText: "ok", shouldRespond: true })}`;
		expect(
			getStage1RetryReason(rawWithToolArguments(argumentsText)),
		).toBeNull();
	});

	it("still rejects a duplicated stream whose fragments genuinely differ", () => {
		const argumentsText = `${JSON.stringify({
			shouldRespond: true,
			replyText: "one",
		})}${JSON.stringify({ shouldRespond: true, replyText: "two" })}`;
		expect(getStage1RetryReason(rawWithToolArguments(argumentsText))).toBe(
			"malformed HANDLE_RESPONSE tool call",
		);
	});

	it("accepts nesting up to the depth budget and rejects one level past it", () => {
		// The recovered fragment is the walk root at depth 0, so 32 nested objects
		// is the deepest accepted shape.
		const atBudget = `{"shouldRespond":true,"replyText":${JSON.stringify(
			"x",
		)},"d":${nestedObjectJson(30)}}`;
		expect(
			getStage1RetryReason(rawWithToolArguments(duplicatedStream(atBudget))),
		).toBeNull();

		const pastBudget = `{"shouldRespond":true,"replyText":${JSON.stringify(
			"x",
		)},"d":${nestedObjectJson(32)}}`;
		expect(
			getStage1RetryReason(rawWithToolArguments(duplicatedStream(pastBudget))),
		).toBe("malformed HANDLE_RESPONSE tool call");
	});

	it("charges array width, so an over-wide fragment is declined not walked", () => {
		const wide = `{"shouldRespond":true,"contexts":[${Array.from(
			{ length: 25_000 },
			(_, index) => index,
		).join(",")}]}`;
		expect(
			getStage1RetryReason(rawWithToolArguments(duplicatedStream(wide))),
		).toBe("malformed HANDLE_RESPONSE tool call");

		// Well under the node budget still recovers — the cap is a real budget,
		// not a blanket rejection of wide planner output. (Width is charged once
		// up front and once per visited element, matching `connector-json.ts`.)
		const narrow = `{"shouldRespond":true,"contexts":[${Array.from(
			{ length: 8_000 },
			(_, index) => index,
		).join(",")}]}`;
		expect(
			getStage1RetryReason(rawWithToolArguments(duplicatedStream(narrow))),
		).toBeNull();
	});
});
