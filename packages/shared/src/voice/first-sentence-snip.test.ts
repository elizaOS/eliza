import { describe, expect, it } from "vitest";
import {
	FIRST_SENTENCE_MAX_WORDS,
	FIRST_SENTENCE_SNIP_VERSION,
	firstSentenceSnip,
	normalizeForKey,
	wordCount,
} from "./first-sentence-snip.js";

describe("FIRST_SENTENCE_SNIP_VERSION", () => {
	it("is a non-empty stable string", () => {
		expect(typeof FIRST_SENTENCE_SNIP_VERSION).toBe("string");
		expect(FIRST_SENTENCE_SNIP_VERSION.length).toBeGreaterThan(0);
		// Pin so a bump becomes a visible test diff (= cache invalidation event).
		expect(FIRST_SENTENCE_SNIP_VERSION).toBe("1");
	});
});

describe("wordCount", () => {
	it("counts ASCII words", () => {
		expect(wordCount("got it")).toBe(2);
		expect(wordCount("hello world how are you")).toBe(5);
	});
	it("counts contractions as one word", () => {
		expect(wordCount("it's")).toBe(1);
		expect(wordCount("don't worry")).toBe(2);
	});
	it("counts hyphenated words as one word", () => {
		expect(wordCount("twenty-three blue cars")).toBe(3);
	});
	it("handles unicode letters", () => {
		expect(wordCount("café résumé")).toBe(2);
		expect(wordCount("你好 世界")).toBe(2);
	});
	it("returns 0 for empty / whitespace", () => {
		expect(wordCount("")).toBe(0);
		expect(wordCount("   ")).toBe(0);
	});
});

describe("normalizeForKey", () => {
	it("lower-cases and trims", () => {
		expect(normalizeForKey("  Got It.  ")).toBe("got it");
	});
	it("strips trailing terminators including runs", () => {
		expect(normalizeForKey("Wait...")).toBe("wait");
		expect(normalizeForKey("Maybe?!")).toBe("maybe");
	});
	it("collapses whitespace", () => {
		expect(normalizeForKey("hi    there")).toBe("hi there");
	});
	it("preserves apostrophes inside words", () => {
		expect(normalizeForKey("It's done.")).toBe("it's done");
	});
	it("applies NFC", () => {
		// "é" composed vs decomposed should produce the same key.
		const composed = "café";
		const decomposed = "café";
		expect(normalizeForKey(composed)).toBe(normalizeForKey(decomposed));
	});
	it("strips trailing CJK terminators", () => {
		expect(normalizeForKey("我知道了。")).toBe("我知道了");
		expect(normalizeForKey("好吗？")).toBe("好吗");
	});
});

describe("firstSentenceSnip — happy path", () => {
	it("snips simple period-terminated openers", () => {
		const r = firstSentenceSnip("Got it.");
		expect(r).not.toBeNull();
		expect(r?.raw).toBe("Got it.");
		expect(r?.normalized).toBe("got it");
		expect(r?.wordCount).toBe(2);
		expect(r?.endOffset).toBe(7);
	});
	it("snips exclamation-terminated openers", () => {
		const r = firstSentenceSnip("Sure thing!");
		expect(r?.normalized).toBe("sure thing");
		expect(r?.wordCount).toBe(2);
	});
	it("snips question-terminated openers", () => {
		const r = firstSentenceSnip("Maybe?");
		expect(r?.normalized).toBe("maybe");
		expect(r?.wordCount).toBe(1);
	});
	it("keeps ellipsis-style terminator runs intact", () => {
		const r = firstSentenceSnip("Wait...");
		expect(r?.raw).toBe("Wait...");
		expect(r?.normalized).toBe("wait");
	});
	it("returns the first sentence when multiple follow", () => {
		const r = firstSentenceSnip("Hi.\nI'm Eliza.");
		expect(r?.raw).toBe("Hi.");
		expect(r?.normalized).toBe("hi");
	});
	it("treats CJK terminators as boundaries", () => {
		const r = firstSentenceSnip("我知道了。");
		expect(r?.normalized).toBe("我知道了");
		expect(r?.wordCount).toBe(1);
	});
});

describe("firstSentenceSnip — abbreviations and decimals", () => {
	it("does not split on `Mr.`", () => {
		const r = firstSentenceSnip("Mr. Smith called.");
		expect(r?.raw).toBe("Mr. Smith called.");
		expect(r?.normalized).toBe("mr. smith called");
		expect(r?.wordCount).toBe(3);
	});
	it("does not split on decimal point", () => {
		const r = firstSentenceSnip("It's 3.14.");
		expect(r?.raw).toBe("It's 3.14.");
		expect(r?.normalized).toBe("it's 3.14");
		expect(r?.wordCount).toBe(2);
	});
	it("does not split on `e.g.`", () => {
		// No real terminator → null (don't risk caching unterminated text).
		const r = firstSentenceSnip("e.g. cats");
		expect(r).toBeNull();
	});
	it("does not split on `U.S.`", () => {
		const r = firstSentenceSnip("U.S. policy is.");
		expect(r?.raw).toBe("U.S. policy is.");
		expect(r?.wordCount).toBe(3);
	});
});

describe("firstSentenceSnip — quotes", () => {
	it("ignores terminators inside double quotes", () => {
		const r = firstSentenceSnip('She said "hello." Then left.');
		expect(r?.raw).toBe('She said "hello." Then left.');
		// 5 normalised words: she said hello then left
		expect(r?.wordCount).toBe(5);
	});
	it("ignores terminators inside fancy quotes", () => {
		const r = firstSentenceSnip("She said “hello.” Then left.");
		expect(r?.raw).toBe("She said “hello.” Then left.");
	});
});

describe("firstSentenceSnip — rejection cases", () => {
	it("returns null for empty input", () => {
		expect(firstSentenceSnip("")).toBeNull();
		expect(firstSentenceSnip("   ")).toBeNull();
	});
	it("returns null for text with no terminator", () => {
		expect(firstSentenceSnip("just words without end")).toBeNull();
	});
	it("returns null when first sentence > 10 words", () => {
		const r = firstSentenceSnip(
			"This is a sentence that is way too long to bother caching, full stop.",
		);
		expect(r).toBeNull();
	});
	it("accepts exactly 10 words", () => {
		const r = firstSentenceSnip("one two three four five six seven eight nine ten.");
		expect(r?.wordCount).toBe(FIRST_SENTENCE_MAX_WORDS);
		expect(r).not.toBeNull();
	});
	it("rejects 11 words", () => {
		const r = firstSentenceSnip(
			"one two three four five six seven eight nine ten eleven.",
		);
		expect(r).toBeNull();
	});
});

describe("firstSentenceSnip — zero-width and unicode whitespace", () => {
	it("strips zero-width space leading whitespace", () => {
		const r = firstSentenceSnip("​  Sure!");
		expect(r?.normalized).toBe("sure");
	});
});

describe("firstSentenceSnip — deterministic key normalisation", () => {
	it("same logical text → same normalised key across whitespace/case", () => {
		const a = firstSentenceSnip("Got it.");
		const b = firstSentenceSnip("  GOT  IT.  ");
		expect(a?.normalized).toBe(b?.normalized);
	});
	it("different terminator runs → same normalised key", () => {
		const a = firstSentenceSnip("Wait.");
		const b = firstSentenceSnip("Wait...");
		const c = firstSentenceSnip("Wait!?");
		expect(a?.normalized).toBe(b?.normalized);
		expect(b?.normalized).toBe(c?.normalized);
	});
});
