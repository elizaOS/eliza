/**
 * Regression for context-summary provider surrogate-safe truncation (3000).
 */

import { describe, expect, it } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../../utils/well-formed.ts";

const MAX_SUMMARY_TEXT_LENGTH = 3000;

function clampSummary(summary: string): string {
	const wellFormed = toWellFormedUnicode(summary);
	return wellFormed.length > MAX_SUMMARY_TEXT_LENGTH
		? `${truncateWellFormed(wellFormed, MAX_SUMMARY_TEXT_LENGTH - 3)}...`
		: wellFormed;
}

function isWellFormed(value: string): boolean {
	if (!value) return true;
	if (
		typeof (value as unknown as { isWellFormed?: () => boolean })
			.isWellFormed === "function"
	)
		return (value as unknown as { isWellFormed: () => boolean }).isWellFormed();
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const n = value.charCodeAt(i + 1);
			if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
			i++;
		} else if (c >= 0xdc00 && c <= 0xdfff) return false;
	}
	return true;
}

describe("context-summary well-formed", () => {
	it("keeps surrogate intact at 3000 boundary", () => {
		const emoji = String.fromCharCode(0xd83d, 0xde00);
		const input = `${"a".repeat(2999)}${emoji}${"b".repeat(20)}`;
		const out = clampSummary(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBeLessThanOrEqual(3000);
		expect(out.endsWith("...")).toBe(true);
	});

	it("preserves fitting emoji", () => {
		const emoji = String.fromCharCode(0xd83d, 0xde00);
		const input = `${"a".repeat(2995)}${emoji}`;
		const out = clampSummary(input);
		expect(isWellFormed(out)).toBe(true);
	});

	it("sanitizes lone surrogate", () => {
		const lone = `summary ${String.fromCharCode(0xd800)} text`;
		const out = clampSummary(`${lone}${"x".repeat(4000)}`);
		expect(isWellFormed(out)).toBe(true);
	});

	it("short passthrough", () => {
		const out = clampSummary("short summary");
		expect(out).toBe("short summary");
	});

	it("sweep around 3000 well-formed", () => {
		const emoji = String.fromCharCode(0xd83e, 0xdd8a);
		for (let n = 2995; n <= 3005; n++) {
			const input = `${"x".repeat(n)}${emoji}${"y".repeat(20)}`;
			const out = clampSummary(input);
			expect(isWellFormed(out)).toBe(true);
			expect(out.length).toBeLessThanOrEqual(3000);
		}
	});
});
