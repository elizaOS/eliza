/**
 * Surrogate-safe truncation for should-respond risk gate (4000/200/300 caps).
 * Verifies caps never split an astral surrogate pair and sanitize lone surrogates.
 */
import { describe, expect, it } from "vitest";

import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../utils/well-formed.ts";

function buildPrompt(text: string): string {
	return truncateWellFormed(toWellFormedUnicode(text), 4000);
}
function truncateResponse(text: string): string {
	return truncateWellFormed(toWellFormedUnicode(text), 200);
}
function truncateReason(reason: string | undefined, fallback: string): string {
	const raw = reason?.trim() ?? "";
	return truncateWellFormed(toWellFormedUnicode(raw), 300) || fallback;
}

function isWellFormed(s: string): boolean {
	const w = s as unknown as { isWellFormed?: () => boolean };
	if (typeof w.isWellFormed === "function") return w.isWellFormed();
	return toWellFormedUnicode(s) === s;
}

describe("should-respond-risk-gate surrogate handling", () => {
	it("prompt 4000 backs off at surrogate boundary", () => {
		const input = "a".repeat(3999) + "🦊" + "b".repeat(20);
		const out = buildPrompt(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBeLessThanOrEqual(4000);
		expect(out.length).toBe(3999);
	});

	it("prompt 4000 preserves fitting emoji", () => {
		const input = "a".repeat(3998) + "🦊";
		const out = buildPrompt(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe("a".repeat(3998) + "🦊");
	});

	it("response 200 caps and stays well-formed sweep", () => {
		for (let off = 0; off < 20; off++) {
			const input = "a".repeat(190 + off) + "🦊" + "b".repeat(100);
			const out = truncateResponse(input);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(200);
		}
	});

	it("reason 300 sanitizes lone surrogate and backs off", () => {
		const lone = "ok \ud800 reason " + "a".repeat(500);
		const out = truncateReason(lone, "fallback");
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("�")).toBe(true);
		const emoji = "a".repeat(299) + "🦊" + "b".repeat(20);
		const out2 = truncateReason(emoji, "fallback");
		expect(isWellFormed(out2)).toBe(true);
		expect(out2.length).toBeLessThanOrEqual(300);
		expect(truncateReason(undefined, "adjudicated block")).toBe(
			"adjudicated block",
		);
		expect(truncateReason("", "adjudicated allow")).toBe("adjudicated allow");
	});
});
