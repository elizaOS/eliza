/**
 * Surrogate-safe truncation for trajectory query and validated field.
 * Mirrors the S-Tier well-formed helpers used in runtime.ts.
 */
import { describe, expect, it } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "./utils/well-formed.js";

function isWellFormed(value: string): boolean {
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return toWellFormedUnicode(value) === value;
}

function trajectoryPreview(text: string): string {
	return truncateWellFormed(toWellFormedUnicode(text), 2000);
}

function truncateValidatedField(content: string): string {
	const wellFormed = toWellFormedUnicode(content);
	return wellFormed.length > 500
		? `${truncateWellFormed(wellFormed, 497)}...`
		: wellFormed;
}

describe("runtime trajectory surrogate safety", () => {
	it("backs off high surrogate at 2000: 1999+'🦊'+tail → 1999 well-formed", () => {
		const input = `${"a".repeat(1999)}🦊${"b".repeat(10)}`;
		const out = trajectoryPreview(input);
		expect(out.length).toBe(1999);
		expect(isWellFormed(out)).toBe(true);
		expect(() => JSON.stringify(out)).not.toThrow();
	});

	it("keeps fitting emoji exactly at 2000: 1998+'🦊' → 2000 well-formed", () => {
		const input = `${"a".repeat(1998)}🦊`;
		const out = trajectoryPreview(input);
		expect(out.length).toBe(2000);
		expect(out).toBe(input);
		expect(isWellFormed(out)).toBe(true);
	});

	it("passes short text through unchanged well-formed", () => {
		const input = "hello 🦊 world";
		const out = trajectoryPreview(input);
		expect(out).toBe(toWellFormedUnicode(input));
		expect(isWellFormed(out)).toBe(true);
	});

	it("sanitizes lone high surrogate \\ud800 → � at 2000", () => {
		const input = `${"a".repeat(10)}\ud800${"b".repeat(10)}`;
		const out = trajectoryPreview(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out).not.toContain("\ud800");
		expect(out).toContain("�");
	});

	it("sanitizes lone low surrogate \\udc00 → � at 2000", () => {
		const input = `${"a".repeat(10)}\udc00${"b".repeat(10)}`;
		const out = trajectoryPreview(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out).not.toContain("\udc00");
		expect(out).toContain("�");
	});

	it("backs off at 497 for validated field: 496+'🦊'+tail → 496+ellipsis well-formed", () => {
		const input = `${"a".repeat(496)}🦊${"b".repeat(50)}`;
		const out = truncateValidatedField(input);
		expect(out.length).toBe(499);
		expect(out.endsWith("...")).toBe(true);
		expect(isWellFormed(out)).toBe(true);
		expect(out.slice(0, 497).length).toBe(497);
		// 496 + ellipsis, not split surrogate
		expect(isWellFormed(out.slice(0, 497))).toBe(true);
	});

	it("sweep 0..30 at 2000: each n+'🦊'+tail → well-formed no throw", () => {
		for (let n = 0; n <= 30; n++) {
			const input = `${"a".repeat(1985 + n)}🦊${"x".repeat(40)}`;
			const out = trajectoryPreview(input);
			expect(isWellFormed(out)).toBe(true);
			expect(() => JSON.stringify(out)).not.toThrow();
			expect(out.length).toBeLessThanOrEqual(2000);
		}
	});

	it("sweep 0..30 at 500: validated field boundary well-formed", () => {
		for (let n = 0; n <= 30; n++) {
			const input = `${"a".repeat(485 + n)}🦊${"y".repeat(40)}`;
			const out = truncateValidatedField(input);
			expect(isWellFormed(out)).toBe(true);
			expect(() => JSON.stringify(out)).not.toThrow();
			expect(out.length).toBeLessThanOrEqual(500);
		}
	});
});
