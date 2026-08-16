import { describe, expect, it } from "vitest";
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
		const output = parseEvaluatorOutput(
			`<reasoning>garbage with no close${ENVELOPE}`,
		);
		expect(output.protocolFailure).toBe(true);
		expect(output.parseError).toBeDefined();
		expect(output.messageToUser).toBeUndefined();
	});
});

describe("shared reasoning-tag grammar", () => {
	it("strips through the last closing tag and removes stray tokens", () => {
		expect(
			stripReasoningPrefixes(
				"first</thought>second</ REASONING >Visible <Think>answer",
			),
		).toBe("Visible answer");
	});

	it("detects open and close markup for every canonical spelling", () => {
		for (const tag of REASONING_TAG_NAMES) {
			expect(hasReasoningResidue(`<${tag}>private`)).toBe(true);
			expect(hasReasoningResidue(`</${tag.toUpperCase()}>`)).toBe(true);
			expect(hasReasoningResidue(`</ ${tag} >`)).toBe(true);
		}
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
});
