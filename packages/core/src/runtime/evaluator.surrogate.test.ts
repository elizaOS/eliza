/** Surrogate safety for parseEvaluatorLabelLine in evaluator.ts. */
import { describe, expect, test } from "vitest";
import { parseEvaluatorLabelLine } from "./evaluator.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return true;
}

describe("evaluator parseEvaluatorLabelLine surrogate safety", () => {
	test("emoji in label prefix evaluated safely without throwing", () => {
		const fox = "🦊";
		const input = `thought${fox}: Here is the final thought`;
		const res = parseEvaluatorLabelLine(input);
		// With emoji in label, isKnownEvaluatorTextLabel should safely return null without throw
		expect(() => JSON.stringify({ res })).not.toThrow();
	});

	test("known decision label with emoji in value parsed cleanly", () => {
		const fox = "🦊";
		const input = `decision: FINISH ${fox} task accomplished`;
		const res = parseEvaluatorLabelLine(input);
		expect(res).not.toBeNull();
		if (res) {
			expect(isWellFormed(res.value)).toBe(true);
			expect(res.label).toBe("decision");
			expect(res.value).toBe(`FINISH ${fox} task accomplished`);
		}
	});

	test("known thought label with emoji in value parsed cleanly", () => {
		const fox = "🦊";
		const input = `thought: All goals achieved ${fox}`;
		const res = parseEvaluatorLabelLine(input);
		expect(res).not.toBeNull();
		if (res) {
			expect(isWellFormed(res.value)).toBe(true);
			expect(res.label).toBe("thought");
			expect(res.value).toBe(`All goals achieved ${fox}`);
		}
	});

	test("lone high surrogate in label line sanitized safely", () => {
		const badInput = "thought: Bad \ud800 in thought line";
		const res = parseEvaluatorLabelLine(badInput);
		expect(res).not.toBeNull();
		if (res) {
			expect(isWellFormed(res.value)).toBe(true);
		}
	});

	test("sweep whitespace with emojis before colon stays safe", () => {
		const fox = "🦊";
		for (let spaces = 0; spaces < 5; spaces++) {
			const input = `thought${" ".repeat(spaces)}${fox}: value`;
			expect(() => parseEvaluatorLabelLine(input)).not.toThrow();
		}
	});
});
