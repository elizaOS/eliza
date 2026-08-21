/**
 * Regression for outbound envelope guard surrogate safety.
 * REPORT_PREVIEW_CHARS=400 is error-ring preview for blocked envelope.
 */

import { describe, expect, it } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../utils/well-formed.ts";

const REPORT_PREVIEW_CHARS = 400;

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return toWellFormedUnicode(value) === value;
}

function preview(blockedText: string): string {
	return truncateWellFormed(
		toWellFormedUnicode(blockedText),
		REPORT_PREVIEW_CHARS,
	);
}

describe("outbound-envelope-guard surrogate handling", () => {
	it("backs off high surrogate at 400 boundary (399+fox->399)", () => {
		const fox = "🦊";
		const text = `${"a".repeat(399)}${fox}${"b".repeat(20)}`;
		const out = preview(text);
		expect(isWellFormed(out)).toBe(true);
		expect(() => JSON.stringify(out)).not.toThrow();
		expect(out).toBe("a".repeat(399));
		expect(out.length).toBe(399);
	});

	it("preserves fitting astral at 398+fox", () => {
		const fox = "🦊";
		const text = `${"a".repeat(398)}${fox}`;
		const out = preview(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("short preview passthrough remains well-formed", () => {
		const text = "blocked envelope fragment short";
		const out = preview(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("sanitizes lone high surrogate before truncate", () => {
		const lone = `blocked ${String.fromCharCode(0xd800)} envelope ${"x".repeat(500)}`;
		const out = preview(lone);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
		expect(out.includes(String.fromCharCode(0xd800))).toBe(false);
	});

	it("sanitizes lone low surrogate before truncate", () => {
		const lone = `blocked ${String.fromCharCode(0xdc00)} envelope ${"x".repeat(500)}`;
		const out = preview(lone);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
	});

	it("caps at 800 with different limit: 799+fox->799", () => {
		// Different cap to prove helper works at other limits too
		const fox = "🦊";
		const text = `${"a".repeat(799)}${fox}${"b".repeat(20)}`;
		const out = truncateWellFormed(toWellFormedUnicode(text), 800);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe("a".repeat(799));
	});

	it("sweep 0..30 offsets at 400 all well-formed", () => {
		const fox = "🦊";
		for (let n = 0; n <= 30; n++) {
			const text = `${"a".repeat(n)}${fox}${"b".repeat(500)}`;
			const out = preview(text);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(400);
			expect(() => JSON.stringify(out)).not.toThrow();
		}
	});

	it("sweep lone surrogate at 400 stays well-formed", () => {
		for (let n = 0; n <= 30; n++) {
			const text = `${"a".repeat(n)}${String.fromCharCode(0xd800)}${"b".repeat(500)}`;
			const out = preview(text);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(400);
		}
	});
});
