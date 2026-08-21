/**
 * Regression for external-content surrogate safety.
 * detectSuspiciousPatterns clamps at 100_000 before pattern tests.
 */

import { describe, expect, it } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../utils/well-formed.ts";

const LIMIT = 100_000;

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return toWellFormedUnicode(value) === value;
}

function clamp(content: string): string {
	return truncateWellFormed(toWellFormedUnicode(content), LIMIT);
}

describe("external-content surrogate handling", () => {
	it("backs off high surrogate at 100k boundary (99999+fox->99999)", () => {
		const fox = "🦊";
		const text = `${"a".repeat(99_999)}${fox}${"b".repeat(20)}`;
		const out = clamp(text);
		expect(isWellFormed(out)).toBe(true);
		expect(() => JSON.stringify(out)).not.toThrow();
		expect(out).toBe("a".repeat(99_999));
		expect(out.length).toBe(99_999);
	});

	it("preserves fitting astral at 99998+fox", () => {
		const fox = "🦊";
		const text = `${"a".repeat(99_998)}${fox}`;
		const out = clamp(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("short content passthrough remains well-formed", () => {
		const text = "external webhook payload short";
		const out = clamp(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("sanitizes lone high surrogate before clamp", () => {
		const lone = `payload ${String.fromCharCode(0xd800)} injected ${"x".repeat(100_100)}`;
		const out = clamp(lone);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
		expect(out.includes(String.fromCharCode(0xd800))).toBe(false);
	});

	it("sanitizes lone low surrogate before clamp", () => {
		const lone = `payload ${String.fromCharCode(0xdc00)} injected ${"x".repeat(100_100)}`;
		const out = clamp(lone);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
	});

	it("caps at 500 with different limit: 499+fox->499", () => {
		const fox = "🦊";
		const text = `${"a".repeat(499)}${fox}${"b".repeat(20)}`;
		const out = truncateWellFormed(toWellFormedUnicode(text), 500);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe("a".repeat(499));
	});

	it("sweep near 100k boundary all well-formed", () => {
		const fox = "🦊";
		for (let delta = 0; delta <= 30; delta++) {
			const n = 99_985 + delta;
			const text = `${"a".repeat(n)}${fox}${"b".repeat(200)}`;
			const out = clamp(text);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(LIMIT);
			expect(() => JSON.stringify(out)).not.toThrow();
		}
	});

	it("sweep lone surrogate near 100k stays well-formed", () => {
		for (let delta = 0; delta <= 30; delta++) {
			const n = 99_985 + delta;
			const text = `${"a".repeat(n)}${String.fromCharCode(0xd800)}${"b".repeat(200)}`;
			const out = clamp(text);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(LIMIT);
		}
	});
});
