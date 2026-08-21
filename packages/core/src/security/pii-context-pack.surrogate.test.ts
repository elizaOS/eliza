/**
 * Regression for PII context pack surrogate safety.
 * Pack is model-seam input for PII_SCRUB, capped at 4000 chars.
 */

import { describe, expect, it } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../utils/well-formed.ts";

const MAX_CHARS = 4000;

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return toWellFormedUnicode(value) === value;
}

function packTruncate(contextPack: string, maxChars = MAX_CHARS): string {
	const wellFormed = toWellFormedUnicode(contextPack);
	if (wellFormed.length > maxChars)
		return truncateWellFormed(wellFormed, maxChars);
	return wellFormed;
}

describe("pii-context-pack surrogate handling", () => {
	it("backs off high surrogate at 4000 boundary (3999+fox->3999)", () => {
		const fox = "🦊";
		const text = `${"a".repeat(3999)}${fox}${"b".repeat(20)}`;
		const out = packTruncate(text, 4000);
		expect(isWellFormed(out)).toBe(true);
		expect(() => JSON.stringify(out)).not.toThrow();
		expect(out).toBe("a".repeat(3999));
	});

	it("preserves fitting astral at 3998+fox", () => {
		const fox = "🦊";
		const text = `${"a".repeat(3998)}${fox}`;
		const out = packTruncate(text, 4000);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("short pack passthrough remains well-formed", () => {
		const text = "Related context:\n- [memories] short fragment";
		const out = packTruncate(text, 4000);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("sanitizes lone high surrogate before truncate", () => {
		const lone = `Related context:\n- [doc] ok ${String.fromCharCode(0xd800)} fragment ${"x".repeat(5000)}`;
		const out = packTruncate(lone, 4000);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
		expect(out.includes(String.fromCharCode(0xd800))).toBe(false);
	});

	it("sanitizes lone low surrogate before truncate", () => {
		const lone = `Related context:\n- [doc] ok ${String.fromCharCode(0xdc00)} fragment ${"x".repeat(5000)}`;
		const out = packTruncate(lone, 4000);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
	});

	it("caps at 500 for small maxChars with fox", () => {
		const fox = "🦊";
		const text = `${"a".repeat(499)}${fox}${"b".repeat(20)}`;
		const out = packTruncate(text, 500);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBeLessThanOrEqual(500);
		expect(out).toBe("a".repeat(499));
	});

	it("sweep 0..30 offsets at 4000 all well-formed", () => {
		const fox = "🦊";
		for (let n = 0; n <= 30; n++) {
			const text = `${"a".repeat(n)}${fox}${"b".repeat(5000)}`;
			const out = packTruncate(text, 4000);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(4000);
			expect(() => JSON.stringify(out)).not.toThrow();
		}
	});

	it("sweep lone surrogate at 4000 stays well-formed", () => {
		for (let n = 0; n <= 30; n++) {
			const text = `${"a".repeat(n)}${String.fromCharCode(0xd800)}${"b".repeat(5000)}`;
			const out = packTruncate(text, 4000);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(4000);
		}
	});
});
