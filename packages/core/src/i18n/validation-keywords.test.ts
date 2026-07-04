/**
 * Core copy of the i18n keyword matcher (a hand-written sibling of the
 * @elizaos/shared one). Pinning it independently guards against drift: ASCII
 * word-boundary matching (so "cat" ≠ "category"), normalization, and
 * longest-term-first selection must behave identically.
 */
import { describe, expect, it } from "vitest";
import {
	collectKeywordTermMatches,
	findKeywordTermMatch,
	normalizeKeywordMatchText,
	splitKeywordDoc,
	textIncludesKeywordTerm,
} from "./validation-keywords.ts";

describe("normalizeKeywordMatchText / splitKeywordDoc", () => {
	it("normalizes and de-duplicates", () => {
		expect(normalizeKeywordMatchText("  Hello   World ")).toBe("hello world");
		expect(splitKeywordDoc("Foo\n foo \n\nBar")).toEqual(["Foo", "Bar"]);
		expect(splitKeywordDoc(undefined)).toEqual([]);
	});
});

describe("textIncludesKeywordTerm", () => {
	it("matches whole ASCII words, not substrings", () => {
		expect(textIncludesKeywordTerm("I have a cat", "cat")).toBe(true);
		expect(textIncludesKeywordTerm("browse the category", "cat")).toBe(false);
		expect(textIncludesKeywordTerm("", "cat")).toBe(false);
	});
});

describe("collectKeywordTermMatches / findKeywordTermMatch", () => {
	it("collects all matches and prefers the longest term", () => {
		expect(
			[
				...collectKeywordTermMatches(
					["delete it", "send now"],
					["delete", "send", "x"],
				),
			].sort(),
		).toEqual(["delete", "send"]);
		expect(
			findKeywordTermMatch("please send money now", ["send", "send money"]),
		).toBe("send money");
		expect(findKeywordTermMatch("nope", ["a", "b"])).toBeUndefined();
	});
});
