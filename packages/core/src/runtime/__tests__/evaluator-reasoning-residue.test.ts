/**
 * Deterministic contract tests for evaluator parsing and final-egress denial
 * of canonical private-reasoning markup, including malformed residue.
 */
import { describe, expect, it } from "vitest";
import { stripReasoningBlocks } from "../../services/message/fallback-reply";
import {
	hasReasoningResidue,
	REASONING_TAG_NAMES,
	stripReasoningPrefixes,
} from "../../utils/reasoning-tags";
import { parseEvaluatorOutput } from "../evaluator";
import { isUnsafeUserVisibleText } from "../planner-loop";

const ENVELOPE =
	'```json\n{ "success": true, "decision": "FINISH", "thought": "done", "messageToUser": "The task is complete." }\n```';

describe("evaluator reasoning-residue stripping", () => {
	it.each([
		["think", "private</think>"],
		["thinking", "<thinking>private</thinking>"],
		["analysis", "<analysis>private</analysis>"],
		["reasoning", "<reasoning>private</reasoning>"],
		["reflection", "<reflection>private</reflection>"],
		["thought", "<thought>private</thought>"],
		["antthinking", "<antthinking>private</antthinking>"],
		["mixed-case think", "private</Think>"],
		["mixed-case thinking", "<THINKING>private</THINKING>"],
		["whitespace close", "private</ think >"],
		["whitespace open", "<thinking >private</ thinking >"],
	])("parses a fenced verdict after a %s prefix", (_label, prefix) => {
		const output = parseEvaluatorOutput(`${prefix}${ENVELOPE}`);
		expect(output.parseError).toBeUndefined();
		expect(output.decision).toBe("FINISH");
		expect(output.messageToUser).toBe("The task is complete.");
	});

	it("preserves the live None-before-close repair", () => {
		const output = parseEvaluatorOutput(`None</think>${ENVELOPE}`);
		expect(output.parseError).toBeUndefined();
		expect(output.decision).toBe("FINISH");
	});

	it("parses a close-only residue prefix", () => {
		const output = parseEvaluatorOutput(
			'reasoning text</thought>{"success":true,"decision":"FINISH","thought":"done","messageToUser":"Recovered."}',
		);
		expect(output.parseError).toBeUndefined();
		expect(output.messageToUser).toBe("Recovered.");
	});

	it("fails closed for an unterminated open-only prefix", () => {
		const output = parseEvaluatorOutput(`<reasoning>${ENVELOPE}`);
		expect(output.protocolFailure).toBe(true);
		expect(output.parseError).toBeDefined();
		expect(output.messageToUser).toBeUndefined();
	});

	it("fails closed when an unterminated block follows a completed block", () => {
		const output = parseEvaluatorOutput(
			`<think>private</think><reasoning>${ENVELOPE}`,
		);
		expect(output.protocolFailure).toBe(true);
		expect(output.parseError).toBeDefined();
		expect(output.messageToUser).toBeUndefined();
	});
});

describe("shared reasoning-tag grammar", () => {
	it("strips through the last completed closing tag", () => {
		expect(
			stripReasoningPrefixes(
				"first</thought>second</ REASONING >Visible answer",
			),
		).toBe("Visible answer");
	});

	it("preserves unmatched open residue so downstream boundaries fail closed", () => {
		expect(stripReasoningPrefixes("<reasoning>private payload")).toBe(
			"<reasoning>private payload",
		);
		expect(
			stripReasoningPrefixes("<think>first</think><reasoning>private payload"),
		).toBe("<reasoning>private payload");
	});

	it("detects open and close markup for every canonical spelling", () => {
		for (const tag of REASONING_TAG_NAMES) {
			expect(hasReasoningResidue(`<${tag}>private`)).toBe(true);
			expect(hasReasoningResidue(`</${tag.toUpperCase()}>`)).toBe(true);
			expect(hasReasoningResidue(`</ ${tag} >`)).toBe(true);
		}
	});

	it("does not classify longer custom tag names as reasoning markup", () => {
		for (const text of [
			"<thought-provoking>Visible</thought-provoking>",
			"<reasoning-disabled>Visible</reasoning-disabled>",
		]) {
			expect(stripReasoningPrefixes(text)).toBe(text);
			expect(hasReasoningResidue(text)).toBe(false);
			expect(stripReasoningBlocks(text)).toBe(text);
		}
	});

	it("uses the same whitespace-tolerant grammar in fallback replies", () => {
		expect(
			stripReasoningBlocks("< thinking >private</ thinking >Visible"),
		).toBe("Visible");
	});

	it("bounds repeated unmatched openings without exposing their payload", () => {
		const residue = `${"<reasoning>".repeat(20_000)}private payload`;
		expect(stripReasoningBlocks(residue)).toBe("");
	});

	it("fails closed on an open tag with no terminator", () => {
		// `[^>]*>` needs a reachable '>' to match at all; without one the old
		// unclosed-tag regex simply didn't match, so the payload sailed through
		// every stripping pass untouched AND `hasReasoningResidue` (built on the
		// same construct) reported no residue — a fail-OPEN gate. The gate must
		// still deny even though the cosmetic stripping passes are a no-op here
		// (the malformed markup "never forms a tag" for them, same as the
		// locked `outbound-sanitize.test.ts` characterization).
		const malformed =
			"<reasoning this-tag-never-terminates and carries a secret payload";
		expect(hasReasoningResidue(malformed)).toBe(true);
		expect(stripReasoningPrefixes(malformed)).toBe(malformed);
		expect(stripReasoningBlocks(malformed)).toBe(malformed);
	});

	it("fails closed on a run of many partial/unterminated candidates", () => {
		// Every candidate in this run individually lacks a '>' — the exact shape
		// a maintainer benchmarked going quadratic (16k candidates, ~3.9s) on the
		// backtracking `[^>]*>` terminator search. The gate must still deny.
		const run = `${"<reasoning ".repeat(16_000)}xsecret payload, no closing bracket anywhere`;
		expect(hasReasoningResidue(run)).toBe(true);
	});

	it.each([
		["residue detection", hasReasoningResidue],
		["block stripping", stripReasoningBlocks],
	] as const)("%s scales without repeated suffix rescanning", (_name, scan) => {
		const buildRun = (n: number) =>
			`${"<reasoning ".repeat(n)}xtrailing text with no closing bracket at all`;
		const small = buildRun(1_600);
		const large = buildRun(16_000);
		const expectedSmall = scan(small);
		const expectedLarge = scan(large);
		const measure = (
			input: string,
			count: number,
			expected: boolean | string,
		) => {
			let result: boolean | string = false;
			const start = performance.now();
			for (let i = 0; i < count; i++) result = scan(input);
			const elapsed = performance.now() - start;
			expect(result).toBe(expected);
			return elapsed;
		};

		// Calibrate on the larger input so even a regressed slow scanner uses
		// one call per batch. Calibration is excluded from the fixed sample set.
		let iterations = 1;
		while (
			measure(large, iterations, expectedLarge) < 20 &&
			iterations < 1_048_576
		)
			iterations *= 2;
		const smallSamples: number[] = [];
		const largeSamples: number[] = [];
		for (let pair = 0; pair < 7; pair++) {
			const takeSmall = () =>
				smallSamples.push(
					measure(small, iterations, expectedSmall) / iterations,
				);
			const takeLarge = () =>
				largeSamples.push(
					measure(large, iterations, expectedLarge) / iterations,
				);
			// Alternate order to avoid consistently assigning JIT/GC drift to one size.
			if (pair % 2 === 0) {
				takeSmall();
				takeLarge();
			} else {
				takeLarge();
				takeSmall();
			}
		}
		// A fixed median tolerates isolated scheduler stalls without retrying a
		// failed assertion or mixing the costs of two different functions.
		const median = (samples: number[]) => {
			const sorted = [...samples].sort((a, b) => a - b);
			const middle = sorted[3];
			if (middle === undefined) throw new Error("Missing fixed timing samples");
			return middle;
		};
		const smallMs = Math.max(median(smallSamples), 0.05);
		const largeMs = median(largeSamples);
		// Retain the original growth and absolute guards: 10x input must not
		// approach quadratic 100x cost, and each large scan stays below 500ms.
		expect(largeMs).toBeLessThan(smallMs * 25);
		expect(largeMs).toBeLessThan(500);
	});
});

describe("reasoning residue at final egress", () => {
	it("rejects surviving open and close tags for every spelling and case", () => {
		for (const tag of REASONING_TAG_NAMES) {
			expect(isUnsafeUserVisibleText(`answer <${tag}>private`)).toBe(true);
			expect(
				isUnsafeUserVisibleText(`private</${tag.toUpperCase()}>answer`),
			).toBe(true);
			expect(isUnsafeUserVisibleText(`private</ ${tag} >answer`)).toBe(true);
		}
	});

	it("passes ordinary prose that mentions reasoning words without markup", () => {
		expect(
			isUnsafeUserVisibleText(
				"I think that thought deserves reflection and careful reasoning.",
			),
		).toBe(false);
	});

	it("rejects a successful-tool prose candidate carrying reasoning markup", () => {
		expect(
			isUnsafeUserVisibleText(
				"The tool completed successfully. <reasoning>inspect another result",
			),
		).toBe(true);
		expect(
			isUnsafeUserVisibleText(
				"The tool completed successfully.</thought>Here is the result.",
			),
		).toBe(true);
	});

	it("rejects an open-only block after prefix stripping", () => {
		const candidate = stripReasoningPrefixes(
			"<think>finished</think><reasoning>private payload",
		);
		expect(candidate).toBe("<reasoning>private payload");
		expect(isUnsafeUserVisibleText(candidate)).toBe(true);
	});
});
