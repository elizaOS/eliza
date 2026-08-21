/**
 * Regression tests for Android bridge diagnostics surrogate safety.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function formatDiagnosticsMessage(msg: string): string {
	return truncateWellFormed(toWellFormedUnicode(msg), 2000);
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

describe("Android bridge diagnostics surrogate safety", () => {
	it("keeps surrogate pairs intact at 2,000-char boundary in fatal diagnostics", () => {
		const fox = String.fromCharCode(0xd83e, 0xdd8a);
		const input = `${"e".repeat(1999)}${fox}${"x".repeat(100)}`;
		const out = formatDiagnosticsMessage(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(1999);
		expect(out).not.toContain("\uD83E");
	});

	it("sanitizes lone surrogates in stack trace and exception strings", () => {
		const lone = `Fatal error ${String.fromCharCode(0xd800)} stack trace ${"s".repeat(3000)}`;
		const out = formatDiagnosticsMessage(lone);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("\uFFFD")).toBe(true);
		expect(out.length).toBeLessThanOrEqual(2000);
	});
});
