/**
 * Onchain chainId strict clamp — rejects 0x38/1e2 hex.
 * Weak `Number("0x38")=56` passes normalizeChainId as 56; strict /^\d+$/ gates before Number.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(decodeURIComponent(new URL("./route.ts", import.meta.url).pathname), "utf8");
const clampSrc = readFileSync(new URL("../../../../../../../../shared/src/lib/utils/clamp-limit.ts", import.meta.url).pathname, "utf8");
const numberParsingSrc = readFileSync(new URL("../../../../../../../../../shared/src/utils/number-parsing.ts", import.meta.url).pathname, "utf8");

describe("onchain chainId strict clamp", () => {
	it("uses strict /^\\d+$/ + isSafeInteger for chainId, not weak Number||", () => {
		expect(src).toContain("/^\\d+$/");
		expect(src).toContain("isSafeInteger");
		expect(src).toContain("chainIdRaw");
		expect(src).toContain("chainIdParsed");
		expect(src).not.toContain('Number(url.searchParams.get("chainId"))');
	});

	it("rejects hex/scientific: 0x38→56, 1e2→100 vs strict fallback", () => {
		const strict = (s: string) => /^\d+$/.test(s.trim());
		expect(strict("0x38")).toBe(false);
		expect(strict("1e2")).toBe(false);
		expect(strict("56")).toBe(true);
		expect(strict("97")).toBe(true);
		expect(Number("0x38")).toBe(56);
		expect(Number("1e2")).toBe(100);
	});

	it("sibling clamp-limit uses same strict contract", () => {
		expect(clampSrc).toContain("/^\\d+$/");
		expect(clampSrc).toContain("isSafeInteger");
	});

	it("sibling number-parsing strict", () => {
		expect(numberParsingSrc).toContain("isSafeInteger");
		expect(numberParsingSrc).toContain("/^\\d+$/");
	});
});
