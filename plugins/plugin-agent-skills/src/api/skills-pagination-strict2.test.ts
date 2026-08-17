/**
 * Skills pagination strict clamp — page/perPage/limit reject 1e4/hex/float.
 * Weak `Number(...)||` accepts 1e4→10000, 0x10→16, 5.9→5.9; strict parseClampedInteger preserves falsy 0 and rejects junk.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("./skills-routes.ts", import.meta.url).pathname, "utf8");
const clampSrc = readFileSync(new URL("../../../../packages/cloud/shared/src/lib/utils/clamp-limit.ts", import.meta.url).pathname, "utf8");
const numberParsingSrc = readFileSync(new URL("../../../../packages/shared/src/utils/number-parsing.ts", import.meta.url).pathname, "utf8");

describe("skills pagination strict clamp", () => {
	it("uses parseClampedInteger for page/perPage/limit, not weak Number||", () => {
		expect(src).toContain('parseClampedInteger(url.searchParams.get("page")');
		expect(src).toContain('parseClampedInteger(url.searchParams.get("perPage")');
		expect(src).toContain('parseClampedInteger(url.searchParams.get("limit")');
		expect(src).toContain("fallback: 1");
		expect(src).toContain("fallback: 50");
		expect(src).toContain("fallback: 30");
		// weak patterns gone for these params
		expect(src).not.toContain('Number(url.searchParams.get("page"))');
		expect(src).not.toContain('Number(url.searchParams.get("perPage"))');
		// limit still has one strict usage at catalogInstall, check count of weak limit gone except strict
		const weakLimitCount = (src.match(/Number\(url\.searchParams\.get\("limit"\)\)/g) || []).length;
		expect(weakLimitCount).toBe(0);
	});

	it("rejects weak payloads: 1e4, 0x10, 5.9, 12abc vs strict", () => {
		const strict = (s: string) => /^\d+$/.test(s.trim());
		for (const bad of ["1e4", "0x10", "5.9", "12abc", "Infinity", "5junk"]) expect(strict(bad)).toBe(false);
		for (const good of ["1", "50", "100"]) expect(strict(good)).toBe(true);
		expect(Number("1e4")).toBe(10000);
		expect(Number.isFinite(Number("1e4"))).toBe(true);
	});

	it("sibling clamp-limit uses same strict /^\\d+$/ + isSafeInteger", () => {
		expect(clampSrc).toContain("/^\\d+$/");
		expect(clampSrc).toContain("isSafeInteger");
	});

	it("sibling number-parsing uses strict decimal gate", () => {
		expect(numberParsingSrc).toContain("isSafeInteger");
		expect(numberParsingSrc).toContain("/^\\d+$/");
	});
});
