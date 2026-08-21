/**
 * Unit tests for `findBreakPoint` surrogate handling — the raw `slice(0,maxLen)`
 * must never split a surrogate pair (emoji) at the fallback boundary, and lone
 * surrogates must be sanitized to `�` before break detection. Uses deterministic
 * `isWellFormed()` assertions.
 */
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { findBreakPoint } from "../draft-chunking.ts";

function isWellFormed(s: string): boolean {
	return s.isWellFormed();
}

describe("findBreakPoint surrogate handling", () => {
	it("keeps surrogate pairs intact at maxLen boundary", () => {
		const emoji = String.fromCharCode(0xd83e, 0xdd8a); // 🦊
		const text = `${"a".repeat(59)}${emoji}${"b".repeat(20)}`;
		const maxLen = 60;
		const breakPoint = findBreakPoint(text, maxLen);
		const wellFormed = toWellFormedUnicode(text);
		const chunk = truncateWellFormed(wellFormed, breakPoint);
		expect(chunk.isWellFormed()).toBe(true);
		expect(isWellFormed(chunk)).toBe(true);
		expect(chunk.length).toBeLessThanOrEqual(maxLen);
		// raw slice would be 60 with lone \ud83e, fixed must back off to 59
		expect(chunk.length).toBe(59);
		expect(chunk).not.toContain(emoji);
	});

	it("preserves fitting emoji under cap", () => {
		const emoji = String.fromCharCode(0xd83e, 0xdd8a);
		const text = `${"a".repeat(58)}${emoji}`;
		const maxLen = 60;
		const breakPoint = findBreakPoint(text, maxLen);
		const wellFormed = toWellFormedUnicode(text);
		const chunk = truncateWellFormed(wellFormed, breakPoint);
		expect(chunk).toBe(wellFormed);
		expect(isWellFormed(chunk)).toBe(true);
		expect(chunk.length).toBe(60);
	});

	it("sanitizes lone high surrogate before break detection", () => {
		const lone = `a${String.fromCharCode(0xd800)}bc ${"x".repeat(50)}`;
		const breakPoint = findBreakPoint(lone, 10);
		const wellFormed = toWellFormedUnicode(lone);
		const chunk = truncateWellFormed(wellFormed, breakPoint);
		expect(chunk).toContain("�");
		expect(isWellFormed(chunk)).toBe(true);
		expect(chunk.isWellFormed()).toBe(true);
	});

	it("sanitizes lone low surrogate before break detection", () => {
		const lone = `a${String.fromCharCode(0xdc00)}bc ${"x".repeat(50)}`;
		const breakPoint = findBreakPoint(lone, 10);
		const wellFormed = toWellFormedUnicode(lone);
		const chunk = truncateWellFormed(wellFormed, breakPoint);
		expect(chunk).toContain("�");
		expect(isWellFormed(chunk)).toBe(true);
	});

	it("never emits lone surrogates at every boundary around 60", () => {
		const emoji = String.fromCharCode(0xd83e, 0xdd8a);
		for (let n = 0; n <= 65; n++) {
			const text = `${"x".repeat(n)}${emoji}${"y".repeat(20)}`;
			const breakPoint = findBreakPoint(text, 60);
			const wellFormed = toWellFormedUnicode(text);
			const chunk = truncateWellFormed(wellFormed, breakPoint);
			expect(isWellFormed(chunk)).toBe(true);
			expect(chunk.isWellFormed()).toBe(true);
			expect(chunk.length).toBeLessThanOrEqual(60);
			expect(breakPoint).toBeLessThanOrEqual(60);
		}
	});

	it("returns well-formed length when under cap even with lone surrogate", () => {
		const lone = `ok ${String.fromCharCode(0xd800)} end`;
		const breakPoint = findBreakPoint(lone, 100);
		const wellFormed = toWellFormedUnicode(lone);
		expect(breakPoint).toBe(wellFormed.length);
		expect(wellFormed).toBe("ok � end");
		expect(isWellFormed(wellFormed)).toBe(true);
	});

	it("backs off astral at 1-char cap to empty well-formed chunk", () => {
		const emoji = String.fromCharCode(0xd83d, 0xde00); // 😀
		const text = `${emoji}${"a".repeat(10)}`;
		const breakPoint = findBreakPoint(text, 1);
		const wellFormed = toWellFormedUnicode(text);
		const chunk = truncateWellFormed(wellFormed, breakPoint);
		expect(chunk.length).toBeLessThanOrEqual(1);
		expect(isWellFormed(chunk)).toBe(true);
		expect(chunk.isWellFormed()).toBe(true);
		// max 1 cannot hold a surrogate pair, so backed off to 0
		expect(chunk.length).toBe(0);
	});
});
