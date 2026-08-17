/**
 * BlueBubbles limit/offset strict clamp — rejects 1e4/hex/float.
 * Weak `Number.parseInt("1e2",10)=1` and `Number("5.9")` float leak; strict parseClampedInteger gates via /^\d+$/ + isSafeInteger.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("./bluebubbles-routes.ts", import.meta.url).pathname, "utf8");
const siblingSrc = readFileSync(new URL("../../../plugin-bluebubbles/src/data-routes.ts", import.meta.url).pathname, "utf8");
const sharedSrc = readFileSync(new URL("../../../../packages/shared/src/utils/number-parsing.ts", import.meta.url).pathname, "utf8");

describe("bluebubbles limit/offset strict clamp", () => {
	it("uses parseClampedInteger for limit/offset, not weak Number.parseInt||", () => {
		expect(src).toContain('parseClampedInteger(url.searchParams.get("limit")');
		expect(src).toContain('parseClampedInteger(url.searchParams.get("offset")');
		expect(src).toContain("fallback: 100");
		expect(src).toContain("fallback: 50");
		expect(src).toContain("fallback: 0");
		expect(src).not.toContain('Number.parseInt(url.searchParams.get("limit")');
		expect(src).not.toContain('Number.parseInt(url.searchParams.get("offset")');
	});

	it("rejects weak payloads: 1e4, 0x10, 5.9, 12abc vs strict", () => {
		const strict = (s: string) => /^\d+$/.test(s.trim());
		for (const bad of ["1e4", "0x10", "5.9", "12abc", "Infinity"]) expect(strict(bad)).toBe(false);
		for (const good of ["1", "50", "100", "0"]) expect(strict(good)).toBe(true);
		expect(Number.parseInt("1e2", 10)).toBe(1);
		expect(Number.parseInt("0x10", 10)).toBe(0);
		expect(Number("5.9")).toBe(5.9);
	});

	it("sibling plugin-bluebubbles uses same strict parsePositiveLimit + parseOffset", () => {
		expect(siblingSrc).toContain("parsePositiveLimit");
		expect(siblingSrc).toContain("parseOffset");
		expect(siblingSrc).toContain("/^[1-9]\\d*$/");
		expect(siblingSrc).toContain("isSafeInteger");
	});

	it("shared number-parsing uses strict gate", () => {
		expect(sharedSrc).toContain("isSafeInteger");
		expect(sharedSrc).toContain("/^\\d+$/");
	});
});
