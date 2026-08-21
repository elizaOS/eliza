/**
 * Regression for action parameter array split capping surrogate safety (10,000).
 */

import { describe, expect, it } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "./utils/well-formed.ts";

const SAFE_SPLIT_LIMIT = 10_000;

function splitParamArray(trimmed: string): string[] {
	const wellFormedTrimmed = toWellFormedUnicode(trimmed);
	const safeTrimmed =
		wellFormedTrimmed.length > SAFE_SPLIT_LIMIT
			? truncateWellFormed(wellFormedTrimmed, SAFE_SPLIT_LIMIT)
			: wellFormedTrimmed;
	return safeTrimmed
		.split(/\|\||,|\n/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function isWellFormed(v: string): boolean {
	if (!v) return true;
	if (
		typeof (v as unknown as { isWellFormed?: () => boolean }).isWellFormed ===
		"function"
	)
		return (v as unknown as { isWellFormed: () => boolean }).isWellFormed();
	for (let i = 0; i < v.length; i++) {
		const c = v.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const n = v.charCodeAt(i + 1);
			if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
			i++;
		} else if (c >= 0xdc00 && c <= 0xdfff) return false;
	}
	return true;
}

describe("action param array split surrogate safety", () => {
	it("keeps surrogate pair intact at 10,000-char boundary", () => {
		const fox = String.fromCharCode(0xd83e, 0xdd8a);
		const input = `${"a".repeat(9999)}${fox},item2,item3`;
		const out = splitParamArray(input);
		expect(out.length).toBeGreaterThan(0);
		for (const item of out) {
			expect(isWellFormed(item)).toBe(true);
		}
	});

	it("preserves multiple emoji array entries under limit", () => {
		const fox = String.fromCharCode(0xd83e, 0xdd8a);
		const input = `tag1,${fox},tag3,${fox} 🦊`;
		const out = splitParamArray(input);
		expect(out).toEqual(["tag1", fox, "tag3", `${fox} 🦊`]);
		for (const item of out) {
			expect(isWellFormed(item)).toBe(true);
		}
	});

	it("sanitizes lone surrogate before splitting", () => {
		const lone = `item1,${String.fromCharCode(0xd800)},${"b".repeat(20000)}`;
		const out = splitParamArray(lone);
		for (const item of out) {
			expect(isWellFormed(item)).toBe(true);
		}
		expect(out[1]).toBe("\uFFFD");
	});
});
