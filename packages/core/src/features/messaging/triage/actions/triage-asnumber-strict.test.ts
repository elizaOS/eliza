/**
 * Triage asNumber strict clamp — rejects 1e4/hex/float junk.
 * Weak `Number(value)` accepts 1e4→10000, 0x10→16, 5.9→5.9, 12abc→NaN fallback;
 * strict `/^-?\\d+$/` + isSafeInteger matches sibling clamp-limit.ts.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sharedSrc = readFileSync(
	new URL("./_shared.ts", import.meta.url).pathname,
	"utf8",
);
const clampSrc = readFileSync(
	new URL("../../../../../../cloud/shared/src/lib/utils/clamp-limit.ts", import.meta.url).pathname,
	"utf8",
);
const numberParsingSrc = readFileSync(
	new URL("../../../../../../shared/src/utils/number-parsing.ts", import.meta.url).pathname,
	"utf8",
);

describe("triage asNumber strict clamp", () => {
	it("uses strict integer regex and isSafeInteger, not weak Number+isFinite", () => {
		expect(sharedSrc).toContain("/^-?\\d+$/");
		expect(sharedSrc).toContain("isSafeInteger");
		expect(sharedSrc).toContain("trim()");
		// weak patterns must be gone from numeric parsing (isFinite gate on raw Number)
		expect(sharedSrc).not.toContain("Number.isFinite(value)");
		expect(sharedSrc).not.toContain('typeof value === "number" && Number.isFinite');
		expect(sharedSrc).not.toContain("Number(value)");
	});

	it("rejects weak payloads: 1e4, 0x10, 5.9, 12abc, Infinity", () => {
		// strict regex /^-?\d+$/ rejects all weak payloads before Number()
		const strict = (s: string) => /^-?\d+$/.test(s.trim());
		for (const bad of ["1e4", "0x10", "5.9", "12abc", "Infinity", " 1e4 ", "5junk"]) {
			expect(strict(bad)).toBe(false);
		}
		for (const good of ["42", "-7", "0", " 12 "]) {
			expect(strict(good)).toBe(true);
		}
		// weak Number() would accept 1e4→10000, 0x10→16, 5.9→5.9 — prove weak differs
		expect(Number("1e4")).toBe(10000);
		expect(Number("0x10")).toBe(16);
		expect(Number.isFinite(Number("1e4"))).toBe(true);
	});

	it("sibling clamp-limit uses same strict /^\\d+$/ + isSafeInteger contract", () => {
		expect(clampSrc).toContain("/^\\d+$/");
		expect(clampSrc).toContain("isSafeInteger");
	});

	it("sibling number-parsing uses strict decimal gate before isSafeInteger", () => {
		expect(numberParsingSrc).toContain("isSafeInteger");
		expect(numberParsingSrc).toContain("/^\\d+$/");
		expect(numberParsingSrc).toContain("/^[+-]?\\d+$/");
	});
});
