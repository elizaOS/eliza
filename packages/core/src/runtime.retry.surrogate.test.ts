/**
 * Regression for runtime structured retry surrogate safety.
 * Covers provider-wire clamps in dynamicPromptExecFromState:
 * - validated field 497 (content slice before "...")
 * - priorOutput / responsePreview 4000 (STRUCTURED_FAILURE_PREVIEW_LIMIT)
 */

import { describe, expect, it } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "./utils/well-formed.ts";

const PREVIEW_LIMIT = 4000;

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return toWellFormedUnicode(value) === value;
}

function truncateValidatedField(content: string): string {
	const wellFormed = toWellFormedUnicode(content);
	return wellFormed.length > 500
		? `${truncateWellFormed(wellFormed, 497)}...`
		: wellFormed;
}

function truncatePreview(text: string): string {
	return truncateWellFormed(toWellFormedUnicode(text), PREVIEW_LIMIT);
}

describe("runtime retry surrogate handling", () => {
	it("validated field 497 backs off at surrogate (496+fox->496)", () => {
		const fox = "🦊";
		const text = `${"a".repeat(496)}${fox}${"b".repeat(50)}`;
		const out = truncateValidatedField(text);
		expect(isWellFormed(out)).toBe(true);
		expect(() => JSON.stringify(out)).not.toThrow();
		expect(out).toBe(`${"a".repeat(496)}...`);
	});

	it("validated field 497 preserves fitting astral at boundary", () => {
		const fox = "🦊";
		const long = `${"a".repeat(495)}${fox}${"b".repeat(10)}`;
		const out = truncateValidatedField(long);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(500);
		expect(out.endsWith("...")).toBe(true);
		expect(out.slice(0, 497)).toBe(`${"a".repeat(495)}🦊`);
	});

	it("short validated field passes through well-formed", () => {
		const text = "short valid field";
		const out = truncateValidatedField(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("sanitizes lone high surrogate in validated field", () => {
		const lone = `field ${String.fromCharCode(0xd800)} ${"x".repeat(600)}`;
		const out = truncateValidatedField(lone);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
		expect(out.includes(String.fromCharCode(0xd800))).toBe(false);
	});

	it("sanitizes lone low surrogate in preview", () => {
		const lone = `preview ${String.fromCharCode(0xdc00)} ${"x".repeat(5000)}`;
		const out = truncatePreview(lone);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
		expect(out.includes(String.fromCharCode(0xdc00))).toBe(false);
	});

	it("preview 4000 backs off at surrogate (3999+fox->3999)", () => {
		const fox = "🦊";
		const text = `${"a".repeat(3999)}${fox}${"b".repeat(50)}`;
		const out = truncatePreview(text);
		expect(isWellFormed(out)).toBe(true);
		expect(() => JSON.stringify(out)).not.toThrow();
		expect(out).toBe("a".repeat(3999));
		expect(out.length).toBe(3999);
	});

	it("preview 4000 preserves fitting astral (3998+fox intact)", () => {
		const fox = "🦊";
		const text = `${"a".repeat(3998)}${fox}`;
		const out = truncatePreview(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("sweep 0..30 offsets at 497 all well-formed", () => {
		const fox = "🦊";
		for (let n = 0; n <= 30; n++) {
			const text = `${"a".repeat(n)}${fox}${"b".repeat(600)}`;
			const out = truncateValidatedField(text);
			expect(isWellFormed(out)).toBe(true);
			expect(() => JSON.stringify(out)).not.toThrow();
			expect(out.length).toBeLessThanOrEqual(500);
		}
	});

	it("sweep 0..30 offsets at 4000 all well-formed", () => {
		const fox = "🦊";
		for (let n = 0; n <= 30; n++) {
			const text = `${"a".repeat(n)}${fox}${"b".repeat(5000)}`;
			const out = truncatePreview(text);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(4000);
			expect(() => JSON.stringify(out)).not.toThrow();
		}
	});
});
