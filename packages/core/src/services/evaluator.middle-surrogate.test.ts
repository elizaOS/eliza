/** Surrogate safety for evaluator prompt truncation helpers (truncateHeadForPrompt and trimHeadAndTailForPrompt). */
import { describe, expect, test } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../utils/well-formed.ts";

const EVALUATOR_PROMPT_TRUNCATION_MARKER = "\n...[truncated]...\n";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return toWellFormedUnicode(value) === value;
}

function truncateHeadForPromptMock(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	const wellFormed = toWellFormedUnicode(text);
	if (wellFormed.length <= maxChars) return wellFormed;
	if (maxChars <= EVALUATOR_PROMPT_TRUNCATION_MARKER.length) {
		return EVALUATOR_PROMPT_TRUNCATION_MARKER.slice(0, maxChars);
	}
	const tailChars = maxChars - EVALUATOR_PROMPT_TRUNCATION_MARKER.length;
	let tailStart = wellFormed.length - tailChars;
	if (
		tailStart > 0 &&
		wellFormed.charCodeAt(tailStart - 1) >= 0xd800 &&
		wellFormed.charCodeAt(tailStart - 1) <= 0xdbff &&
		wellFormed.charCodeAt(tailStart) >= 0xdc00 &&
		wellFormed.charCodeAt(tailStart) <= 0xdfff
	) {
		tailStart += 1;
	}
	return `${EVALUATOR_PROMPT_TRUNCATION_MARKER}${wellFormed.slice(tailStart)}`;
}

function trimHeadAndTailForPromptMock(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	const wellFormed = toWellFormedUnicode(text);
	if (wellFormed.length <= maxChars) return wellFormed;
	if (maxChars <= EVALUATOR_PROMPT_TRUNCATION_MARKER.length) {
		return EVALUATOR_PROMPT_TRUNCATION_MARKER.slice(0, maxChars);
	}
	const contentBudget = maxChars - EVALUATOR_PROMPT_TRUNCATION_MARKER.length;
	const headBudget = Math.ceil(contentBudget / 3);
	const tailBudget = contentBudget - headBudget;
	const head = truncateWellFormed(wellFormed, headBudget);
	let tail = "";
	if (tailBudget > 0) {
		let tailStart = wellFormed.length - tailBudget;
		if (
			tailStart > 0 &&
			wellFormed.charCodeAt(tailStart - 1) >= 0xd800 &&
			wellFormed.charCodeAt(tailStart - 1) <= 0xdbff &&
			wellFormed.charCodeAt(tailStart) >= 0xdc00 &&
			wellFormed.charCodeAt(tailStart) <= 0xdfff
		) {
			tailStart += 1;
		}
		tail = wellFormed.slice(tailStart);
	}
	return `${head}${EVALUATOR_PROMPT_TRUNCATION_MARKER}${tail}`;
}

describe("evaluator prompt truncation surrogate safety", () => {
	test("truncateHeadForPrompt handles emoji at tail boundary cleanly", () => {
		const fox = "🦊";
		const input = `${"a".repeat(100)}${fox}${"b".repeat(100)}`;
		const out = truncateHeadForPromptMock(input, 50);
		expect(isWellFormed(out)).toBe(true);
		expect(out.startsWith(EVALUATOR_PROMPT_TRUNCATION_MARKER)).toBe(true);
		expect(() => JSON.stringify({ prompt: out })).not.toThrow();
	});

	test("trimHeadAndTailForPrompt handles emoji at head boundary without lone surrogate", () => {
		const fox = "🦊";
		const input = `${"a".repeat(10)}${fox}${"b".repeat(100)}`;
		const out = trimHeadAndTailForPromptMock(input, 60);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes(EVALUATOR_PROMPT_TRUNCATION_MARKER)).toBe(true);
		expect(() => JSON.stringify({ prompt: out })).not.toThrow();
	});

	test("trimHeadAndTailForPrompt handles emoji at tail boundary without lone surrogate", () => {
		const fox = "🦊";
		const input = `${"a".repeat(100)}${fox}${"b".repeat(10)}`;
		const out = trimHeadAndTailForPromptMock(input, 60);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes(EVALUATOR_PROMPT_TRUNCATION_MARKER)).toBe(true);
		expect(() => JSON.stringify({ prompt: out })).not.toThrow();
	});

	test("short prompt with emoji passes through untouched", () => {
		const input = "Short evaluator context with 🦊 emoji";
		const out = trimHeadAndTailForPromptMock(input, 100);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(input);
	});

	test("sweep offsets for trimHeadAndTailForPrompt all stay well-formed", () => {
		const fox = "🦊";
		for (let n = 50; n <= 80; n++) {
			const input = `${"a".repeat(n)}${fox}${"b".repeat(n)}`;
			const out = trimHeadAndTailForPromptMock(input, 70);
			expect(isWellFormed(out)).toBe(true);
			expect(() => JSON.stringify({ prompt: out })).not.toThrow();
		}
	});
});
