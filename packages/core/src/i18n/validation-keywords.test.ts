/**
 * Core copy of the i18n keyword matcher (a hand-written sibling of the
 * @elizaos/shared one). Pinning it independently guards against drift: ASCII
 * word-boundary matching (so "cat" ≠ "category"), normalization, and
 * longest-term-first selection must behave identically.
 */
import { describe, expect, it } from "vitest";
import {
	collectKeywordTermMatches as collectSharedKeywordMatches,
	textIncludesKeywordTerm as sharedTextIncludesKeywordTerm,
} from "../../../shared/src/i18n/keyword-matching";
import { getActionSearchKeywordTerms } from "./action-search-keywords";
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
	it("preserves boundary, Unicode, whitespace and insertion-order semantics when batching", () => {
		const texts = [
			"",
			"   ",
			"send money",
			"SEND MONEY",
			"send\tmoney",
			"send  money",
			"ＳＥＮＤ money",
			"Send\u00a0money",
			"browse the category",
			"a cat!",
			"café cat",
			"cafe\u0301",
			"don't repeat",
			"re-open notes",
			"中文笔记",
			"カレンダーを開く",
			"افتح الملاحظات",
			"🙂 water",
			"C++ (notes)",
			"a.b [calendar]",
			"\ud800",
			"send\u0000money",
		];
		const terms = [
			"",
			" ",
			"send",
			"send money",
			"SEND",
			" money ",
			"cat",
			"cat",
			"café",
			"cafe\u0301",
			"don't",
			"re-open",
			"中文",
			"カレンダー",
			"الملاحظات",
			"🙂",
			"C++",
			"(notes)",
			"a.b",
			"[calendar]",
			"\ud800",
		];
		for (const text of texts) {
			for (const term of terms) {
				expect(textIncludesKeywordTerm(text, term)).toBe(
					sharedTextIncludesKeywordTerm(text, term),
				);
			}
		}
		expect([...collectKeywordTermMatches(texts, terms)]).toEqual([
			...collectSharedKeywordMatches(texts, terms),
		]);
		expect([...collectKeywordTermMatches([], terms)]).toEqual([]);
		expect([...collectKeywordTermMatches(texts, [])]).toEqual([]);
	});

	it("retains complete multilingual action-search matches across successive conversations", () => {
		const terms = getActionSearchKeywordTerms({
			name: "VIEWS",
			contexts: ["general", "calendar", "memory", "documents", "browser"],
		});
		const conversations = [
			["Open Notes and remember the charger.", "日历", "افتح المتصفح"],
			["There is water in the bottle.", "Continue with the previous event."],
			["打开日历", "Ouvrir le navigateur", "カレンダー", "abrir notas"],
		];
		for (const texts of conversations) {
			expect([...collectKeywordTermMatches(texts, terms)]).toEqual([
				...collectSharedKeywordMatches(texts, terms),
			]);
		}
	});

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
