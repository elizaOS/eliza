/**
 * Regression tests for Android bridge diagnostics surrogate safety.
 */

import { describe, expect, it } from "vitest";
import { formatAndroidFatalDiagnosticMessage } from "./diagnostics.ts";

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
	it("keeps a pair intact for unhandled-rejection diagnostics", () => {
		const fox = String.fromCharCode(0xd83e, 0xdd8a);
		const input = `${"e".repeat(1999)}${fox}${"x".repeat(100)}`;
		const out = formatAndroidFatalDiagnosticMessage(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe("e".repeat(1999));
	});

	it("sanitizes a lone surrogate in uncaught-exception stack diagnostics", () => {
		const lone = `Fatal error ${String.fromCharCode(0xd800)} stack trace ${"s".repeat(3000)}`;
		const out = formatAndroidFatalDiagnosticMessage(lone);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toContain("Fatal error \uFFFD stack trace");
		expect(out.length).toBeLessThanOrEqual(2000);
	});

	it("sanitizes the boundary code unit in startEliza failure diagnostics", () => {
		const loneLow = String.fromCharCode(0xdc00);
		const input = `${"s".repeat(1999)}${loneLow}ignored`;

		const out = formatAndroidFatalDiagnosticMessage(input);

		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(`${"s".repeat(1999)}\uFFFD`);
		expect(out).toHaveLength(2000);
	});
});
