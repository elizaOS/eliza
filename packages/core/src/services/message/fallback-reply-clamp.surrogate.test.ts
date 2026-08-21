/**
 * Regression for fallback-reply clampForScan surrogate safety (10,000).
 */

import { describe, expect, it } from "vitest";
import {
	clampForScan,
	isInsufficientCreditsMessage,
} from "./fallback-reply.ts";

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

describe("fallback-reply clampForScan surrogate safety", () => {
	it("keeps surrogate pair intact at 10,000-char boundary", () => {
		const fox = String.fromCharCode(0xd83e, 0xdd8a);
		const input = `${"a".repeat(9999)}${fox}${"b".repeat(50)}`;
		const out = clampForScan(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(9999);
		expect(out).not.toContain("\uD83E");
	});

	it("detects billing error with emoji cleanly", () => {
		const fox = String.fromCharCode(0xd83e, 0xdd8a);
		expect(
			isInsufficientCreditsMessage(`Error ${fox}: insufficient_quota`),
		).toBe(true);
	});

	it("sanitizes lone surrogate in error payload", () => {
		const lone = `error ${String.fromCharCode(0xd800)} ${"a".repeat(20000)}`;
		const out = clampForScan(lone);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("\uFFFD")).toBe(true);
		expect(out.length).toBeLessThanOrEqual(10_000);
	});
});
