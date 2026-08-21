/** Surrogate safety for basic capabilities name and tag detection text truncation: safeText must never emit lone surrogates. */
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

function clampSafeText(text: string, max = 10_000): string {
	return truncateWellFormed(toWellFormedUnicode(text), max);
}

describe("basic capabilities safeText surrogate safety", () => {
	test("emoji at 9999 boundary backs off to 9999 without lone surrogate at 10000 cap", () => {
		const input = `${"a".repeat(9999)}🦊${"b".repeat(50)}`;
		const out = clampSafeText(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(9999);
		expect(out.endsWith("🦊")).toBe(false);
		expect(() => JSON.stringify({ safeText: out })).not.toThrow();
	});

	test("fitting emoji ending at 10000 kept intact", () => {
		const input = `${"a".repeat(9998)}🦊`;
		const out = clampSafeText(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(10_000);
		expect(out.endsWith("🦊")).toBe(true);
	});

	test("short message with user tag passes through untouched", () => {
		const input = "Hello @eliza 🦊 how are you?";
		const out = clampSafeText(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(input);
	});

	test("lone high surrogate is sanitized before truncation", () => {
		const input = `bad \ud800 surrogate ${"x".repeat(12_000)}`;
		const out = clampSafeText(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("\ud800")).toBe(false);
		expect(out.length).toBeLessThanOrEqual(10_000);
	});

	test("sweep 9995..10005 emoji offsets at 10000 cap all stay well-formed", () => {
		const fox = "🦊";
		for (let n = 9995; n <= 10005; n++) {
			const input = `${"a".repeat(n)}${fox}${"b".repeat(50)}`;
			const out = clampSafeText(input);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(10_000);
			expect(() => JSON.stringify({ safeText: out })).not.toThrow();
		}
	});
});
