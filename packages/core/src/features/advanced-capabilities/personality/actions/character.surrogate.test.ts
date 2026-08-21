/** Surrogate safety for character action messageText and originalRequest truncation: must never emit lone surrogates. */
import { describe, expect, test } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../../../utils/well-formed.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return toWellFormedUnicode(value) === value;
}

function clampText(text: string, max: number): string {
	return truncateWellFormed(toWellFormedUnicode(text), max);
}

describe("character action surrogate safety", () => {
	test("emoji at 99 boundary backs off to 99 without lone surrogate at 100 cap", () => {
		const input = `${"a".repeat(99)}🦊${"b".repeat(50)}`;
		const out = clampText(input, 100);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(99);
		expect(() => JSON.stringify({ messageText: out })).not.toThrow();
		expect(out.endsWith("🦊")).toBe(false);
	});

	test("fitting emoji ending at 100 kept intact", () => {
		const input = `${"a".repeat(98)}🦊`;
		const out = clampText(input, 100);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(100);
		expect(out.endsWith("🦊")).toBe(true);
	});

	test("emoji at 199 boundary backs off to 199 at 200 cap", () => {
		const input = `${"a".repeat(199)}🦊${"b".repeat(50)}`;
		const out = clampText(input, 200);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(199);
		expect(() => JSON.stringify({ originalRequest: out })).not.toThrow();
		expect(out.endsWith("🦊")).toBe(false);
	});

	test("fitting emoji ending at 200 kept intact", () => {
		const input = `${"a".repeat(198)}🦊`;
		const out = clampText(input, 200);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(200);
		expect(out.endsWith("🦊")).toBe(true);
	});

	test("lone high surrogate is sanitized before truncation", () => {
		const input = `bad \ud800 surrogate ${"x".repeat(150)}`;
		const out = clampText(input, 100);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("\ud800")).toBe(false);
		expect(out.length).toBeLessThanOrEqual(100);
	});

	test("sweep 95..105 emoji offsets at 100 cap all stay well-formed", () => {
		const fox = "🦊";
		for (let n = 95; n <= 105; n++) {
			const input = `${"a".repeat(n)}${fox}${"b".repeat(50)}`;
			const out = clampText(input, 100);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(100);
			expect(() => JSON.stringify({ text: out })).not.toThrow();
		}
	});
});
