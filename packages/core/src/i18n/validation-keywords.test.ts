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

// This module is a byte-for-byte sibling of
// packages/shared/src/i18n/keyword-matching.ts; the same cases are pinned there.
// Word boundaries used to hold only for pure-ASCII text: the pattern was tested
// against the RAW input, so an NFKC-only spelling could not match it, and the
// substring fallback that compensated dropped boundaries for any text carrying
// a non-ASCII character — one emoji was enough.
describe("textIncludesKeywordTerm word boundaries with non-ASCII text", () => {
	it.each([
		["restart the server \u{1F642}", "art"],
		["please reschedule \u{1F642}", "schedule"],
		["I am scanning caf\u00e9", "scan"],
		["classified \u2705", "class"],
	])("does not match %s against %s", (text, term) => {
		expect(textIncludesKeywordTerm(text, term)).toBe(false);
	});

	it.each([
		["run a scan now \u{1F642}", "scan"],
		["\u5f00\u59cbscan\u4efb\u52a1", "scan"],
		["\uff53\uff43\uff41\uff4e now", "scan"],
	])("still matches %s against %s", (text, term) => {
		expect(textIncludesKeywordTerm(text, term)).toBe(true);
	});

	it.each([
		["scan  the   disk", "scan the disk"],
		["scan\nthe disk", "scan the disk"],
	])("matches a multi-word term across %j", (text, term) => {
		expect(textIncludesKeywordTerm(text, term)).toBe(true);
	});
});
