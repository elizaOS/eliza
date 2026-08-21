/** Surrogate safety for securityStatus provider analysis details truncation: must never emit lone surrogates. */
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

function clampSecurityDetails(
	details: string | undefined,
	max = 500,
): string | undefined {
	return details
		? truncateWellFormed(toWellFormedUnicode(details), max)
		: undefined;
}

describe("securityStatus details surrogate safety", () => {
	test("emoji at 499 boundary backs off to 499 without lone surrogate at 500 cap", () => {
		const input = `${"a".repeat(499)}🦊${"b".repeat(50)}`;
		const out = clampSecurityDetails(input);
		expect(out).toBeDefined();
		if (out) {
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBe(499);
			expect(out.endsWith("🦊")).toBe(false);
			expect(() => JSON.stringify({ details: out })).not.toThrow();
		}
	});

	test("fitting emoji ending at 500 kept intact", () => {
		const input = `${"a".repeat(498)}🦊`;
		const out = clampSecurityDetails(input);
		expect(out).toBeDefined();
		if (out) {
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBe(500);
			expect(out.endsWith("🦊")).toBe(true);
		}
	});

	test("short details with emoji passes through untouched", () => {
		const input = "Potential prompt injection detected with emoji 🦊 payload";
		const out = clampSecurityDetails(input);
		expect(out).toBeDefined();
		if (out) {
			expect(isWellFormed(out)).toBe(true);
			expect(out).toBe(input);
		}
	});

	test("lone high surrogate is sanitized before truncation", () => {
		const input = `bad \ud800 surrogate in exploit ${"x".repeat(600)}`;
		const out = clampSecurityDetails(input);
		expect(out).toBeDefined();
		if (out) {
			expect(isWellFormed(out)).toBe(true);
			expect(out.includes("\ud800")).toBe(false);
			expect(out.length).toBeLessThanOrEqual(500);
		}
	});

	test("undefined details returns undefined", () => {
		const out = clampSecurityDetails(undefined);
		expect(out).toBeUndefined();
	});

	test("sweep 495..505 emoji offsets at 500 cap all stay well-formed", () => {
		const fox = "🦊";
		for (let n = 495; n <= 505; n++) {
			const input = `${"a".repeat(n)}${fox}${"b".repeat(50)}`;
			const out = clampSecurityDetails(input);
			expect(out).toBeDefined();
			if (out) {
				expect(isWellFormed(out)).toBe(true);
				expect(out.length).toBeLessThanOrEqual(500);
				expect(() => JSON.stringify({ details: out })).not.toThrow();
			}
		}
	});
});
