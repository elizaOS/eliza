/** Surrogate safety for generateMedia prompt preview truncation: promptPreview must never emit lone surrogates. */
import { describe, expect, test } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../../utils/well-formed.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return toWellFormedUnicode(value) === value;
}

function clampPromptPreview(prompt: string, max = 120): string {
	return truncateWellFormed(toWellFormedUnicode(prompt), max);
}

describe("generateMedia prompt preview surrogate safety", () => {
	test("emoji at 119 boundary backs off to 119 without lone surrogate", () => {
		const input = `${"a".repeat(119)}🦊${"b".repeat(50)}`;
		const out = clampPromptPreview(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(119);
		expect(() => JSON.stringify({ promptPreview: out })).not.toThrow();
		expect(out.endsWith("🦊")).toBe(false);
	});

	test("fitting emoji ending at 120 kept intact", () => {
		const input = `${"a".repeat(118)}🦊`;
		const out = clampPromptPreview(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(120);
		expect(out.endsWith("🦊")).toBe(true);
	});

	test("short prompt with emoji passes through untouched", () => {
		const input = "Generate a cute fox 🦊 in space";
		const out = clampPromptPreview(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(input);
	});

	test("pre-existing lone surrogate is sanitized before truncation", () => {
		const input = `bad \ud800 surrogate ${"x".repeat(150)}`;
		const out = clampPromptPreview(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("\ud800")).toBe(false);
		expect(out.length).toBeLessThanOrEqual(120);
	});

	test("sweep 115..125 emoji offsets at 120 cap all stay well-formed", () => {
		const fox = "🦊";
		for (let n = 115; n <= 125; n++) {
			const input = `${"a".repeat(n)}${fox}${"b".repeat(50)}`;
			const out = clampPromptPreview(input);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(120);
			expect(() => JSON.stringify({ promptPreview: out })).not.toThrow();
		}
	});
});
