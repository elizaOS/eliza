/** Surrogate safety for basic capabilities previews (attachment descriptions, text docs, pdfs, outbound envelope tripwire). */
import { describe, expect, test } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../utils/well-formed.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return toWellFormedUnicode(value) === value;
}

function clampPreview(text: string | undefined, max = 100): string | undefined {
	return text ? truncateWellFormed(toWellFormedUnicode(text), max) : undefined;
}

describe("basic capabilities preview surrogate safety", () => {
	test("emoji at 99 boundary backs off to 99 without lone surrogate at 100 cap", () => {
		const input = `${"a".repeat(99)}🦊${"b".repeat(50)}`;
		const out = clampPreview(input, 100);
		expect(out).toBeDefined();
		if (out) {
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBe(99);
			expect(out.endsWith("🦊")).toBe(false);
			expect(() => JSON.stringify({ preview: out })).not.toThrow();
		}
	});

	test("fitting emoji ending at 100 kept intact", () => {
		const input = `${"a".repeat(98)}🦊`;
		const out = clampPreview(input, 100);
		expect(out).toBeDefined();
		if (out) {
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBe(100);
			expect(out.endsWith("🦊")).toBe(true);
		}
	});

	test("sentText 120 cap boundary backs off at 119", () => {
		const input = `${"a".repeat(119)}🦊${"b".repeat(50)}`;
		const out = clampPreview(input, 120);
		expect(out).toBeDefined();
		if (out) {
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBe(119);
			expect(out.endsWith("🦊")).toBe(false);
			expect(() => JSON.stringify({ preview: out })).not.toThrow();
		}
	});

	test("lone high surrogate is sanitized before truncation", () => {
		const input = `bad \ud800 surrogate ${"x".repeat(300)}`;
		const out = clampPreview(input, 100);
		expect(out).toBeDefined();
		if (out) {
			expect(isWellFormed(out)).toBe(true);
			expect(out.includes("\ud800")).toBe(false);
			expect(out.length).toBeLessThanOrEqual(100);
		}
	});

	test("undefined input returns undefined", () => {
		expect(clampPreview(undefined)).toBeUndefined();
	});

	test("sweep 95..105 emoji offsets all stay well-formed", () => {
		const fox = "🦊";
		for (let n = 95; n <= 105; n++) {
			const input = `${"a".repeat(n)}${fox}${"b".repeat(50)}`;
			const out = clampPreview(input, 100);
			expect(out).toBeDefined();
			if (out) {
				expect(isWellFormed(out)).toBe(true);
				expect(out.length).toBeLessThanOrEqual(100);
				expect(() => JSON.stringify({ preview: out })).not.toThrow();
			}
		}
	});
});
