/**
 * Regression for experience action surrogate safety.
 */

import { describe, expect, it } from "vitest";
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

function truncatedExperience(learning: string, max = 120): string {
	return truncateWellFormed(toWellFormedUnicode(learning), max);
}

describe("manageExperience surrogate truncation", () => {
	it("backs off high surrogate at 120 boundary (119+fox->119)", () => {
		const fox = "🦊";
		const text = `${"a".repeat(119)}${fox}${"b".repeat(20)}`;
		const out = truncatedExperience(text, 120);
		expect(isWellFormed(out)).toBe(true);
		expect(() => JSON.stringify(out)).not.toThrow();
		expect(out).toBe("a".repeat(119));
	});

	it("preserves fitting astral at 118+fox within 120", () => {
		const fox = "🦊";
		const text = `${"a".repeat(118)}${fox}`;
		const out = truncatedExperience(text, 120);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("sanitizes lone high surrogate before truncate", () => {
		const lone = `learn ${String.fromCharCode(0xd800)} ${"x".repeat(200)}`;
		const out = truncatedExperience(lone, 120);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
		expect(out.includes(String.fromCharCode(0xd800))).toBe(false);
	});

	it("sanitizes lone low surrogate before truncate", () => {
		const lone = `learn ${String.fromCharCode(0xdc00)} ${"x".repeat(200)}`;
		const out = truncatedExperience(lone, 120);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
	});

	it("caps at 200 for action result text with fox", () => {
		const fox = "🦊";
		const text = `${"a".repeat(199)}${fox}${"b".repeat(20)}`;
		const out = truncatedExperience(text, 200);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBeLessThanOrEqual(200);
		expect(out).toBe("a".repeat(199));
	});

	it("short learning passthrough remains well-formed", () => {
		const text = "short learning";
		const out = truncatedExperience(text, 120);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("sweep 0..30 offsets at 120 all well-formed", () => {
		const fox = "🦊";
		for (let n = 0; n <= 30; n++) {
			const text = `${"a".repeat(n)}${fox}${"b".repeat(300)}`;
			const out = truncatedExperience(text, 120);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(120);
			expect(() => JSON.stringify(out)).not.toThrow();
		}
	});

	it("sweep at 200 with lone surrogate stays well-formed", () => {
		for (let n = 0; n <= 30; n++) {
			const text = `${"a".repeat(n)}${String.fromCharCode(0xd800)}${"b".repeat(300)}`;
			const out = truncatedExperience(text, 200);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(200);
		}
	});
});
