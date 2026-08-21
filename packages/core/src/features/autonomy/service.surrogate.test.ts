/** Surrogate safety for autonomy service response debug logging. */
import { describe, expect, test } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../utils/well-formed.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return true;
}

function formatAutonomyLogExcerpt(text: string | undefined): string {
	return `Response generated: ${truncateWellFormed(toWellFormedUnicode(text ?? ""), 100)}...`;
}

describe("autonomy service log surrogate safety", () => {
	test("emoji at 99 boundary backs off without lone surrogate", () => {
		const fox = "🦊";
		const input = `${"a".repeat(99)}${fox}${"b".repeat(50)}`;
		const out = formatAutonomyLogExcerpt(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.startsWith("Response generated: ")).toBe(true);
		expect(() => JSON.stringify({ log: out })).not.toThrow();
	});

	test("fitting emoji ending at 100 kept intact", () => {
		const fox = "🦊";
		const input = `${"a".repeat(98)}${fox}`;
		const out = formatAutonomyLogExcerpt(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes(fox)).toBe(true);
	});

	test("short response with emoji passes through untouched", () => {
		const input = "Autonomy plan concluded with 🦊 mascot";
		const out = formatAutonomyLogExcerpt(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes(input)).toBe(true);
	});

	test("lone high surrogate in content text is sanitized", () => {
		const input = `bad \ud800 in autonomy text ${"x".repeat(200)}`;
		const out = formatAutonomyLogExcerpt(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("\ud800")).toBe(false);
	});

	test("sweep offsets around 100 cap all stay well-formed", () => {
		const fox = "🦊";
		for (let offset = -5; offset <= 5; offset++) {
			const n = 100 + offset;
			const input = `${"a".repeat(n)}${fox}${"b".repeat(50)}`;
			const out = formatAutonomyLogExcerpt(input);
			expect(isWellFormed(out)).toBe(true);
			expect(() => JSON.stringify({ log: out })).not.toThrow();
		}
	});
});
