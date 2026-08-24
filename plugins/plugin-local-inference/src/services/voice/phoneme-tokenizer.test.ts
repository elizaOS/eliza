/**
 * Deterministic unit test for the phoneme tokenizer (plugin-local-inference):
 * the synchronous English IPA approximation used by the phrase chunker for
 * boundary counting and rollback range mapping. Pins known-word lookup,
 * digraph-before-letter precedence, case normalization, per-digit mapping,
 * unknown-character skipping, and sourceTokenIndex propagation. Pure-function
 * test — no runtime.
 */
import { describe, expect, it } from "vitest";
import {
	createDefaultPhonemeTokenizer,
	RuleBasedEnglishPhonemeTokenizer,
} from "./phoneme-tokenizer.ts";

function phonemesOf(text: string, index = 0): readonly string[] {
	const tokenizer = new RuleBasedEnglishPhonemeTokenizer();
	return tokenizer.tokenize(text, index).map((p) => p.ipa);
}

describe("known-word lookup", () => {
	it("maps known words from the dictionary table", () => {
		expect(phonemesOf("hello")).toEqual(["h", "ə", "l", "oʊ"]);
		expect(phonemesOf("world")).toEqual(["w", "ɜː", "r", "l", "d"]);
		expect(phonemesOf("eliza")).toEqual(["ə", "l", "iː", "z", "ə"]);
		expect(phonemesOf("the")).toEqual(["ð", "ə"]);
	});

	it("normalizes case before dictionary lookup", () => {
		expect(phonemesOf("Hello")).toEqual(phonemesOf("hello"));
		expect(phonemesOf("ELIZA")).toEqual(phonemesOf("eliza"));
		expect(phonemesOf("The")).toEqual(phonemesOf("the"));
	});

	it("distinguishes a known single letter from the unknown-word path", () => {
		// "a" is a known word; "ab" falls through to letter-by-letter mapping.
		expect(phonemesOf("a")).toEqual(["ə"]);
		expect(phonemesOf("ab")).toEqual(["æ", "b"]);
	});
});

describe("unknown-word letter mapping", () => {
	it("prefers digraphs over single letters", () => {
		expect(phonemesOf("sh")).toEqual(["ʃ"]);
		expect(phonemesOf("ch")).toEqual(["tʃ"]);
		expect(phonemesOf("th")).toEqual(["θ"]);
		expect(phonemesOf("ng")).toEqual(["ŋ"]);
	});

	it("applies digraph precedence mid-word", () => {
		// c-h -> tʃ, u -> ʌ, r -> r, c-h -> tʃ
		expect(phonemesOf("church")).toEqual(["tʃ", "ʌ", "r", "tʃ"]);
		// s-h -> ʃ, e -> ɛ, d -> d
		expect(phonemesOf("shed")).toEqual(["ʃ", "ɛ", "d"]);
	});

	it("maps each unknown letter to its IPA approximation", () => {
		expect(phonemesOf("cat")).toEqual(["k", "æ", "t"]);
		expect(phonemesOf("dog")).toEqual(["d", "ɑ", "ɡ"]);
	});

	it("skips characters with no letter mapping", () => {
		// q maps to k, but an unlisted character is skipped entirely.
		expect(phonemesOf("q")).toEqual(["k"]);
		expect(phonemesOf("")).toEqual([]);
	});
});

describe("digit mapping", () => {
	it("maps each digit to its word-like phoneme sequence", () => {
		expect(phonemesOf("1")).toEqual(["w", "ʌ", "n"]);
		expect(phonemesOf("9")).toEqual(["n", "aɪ", "n"]);
		expect(phonemesOf("0")).toEqual(["z", "iː", "r", "oʊ"]);
	});

	it("maps multi-digit strings digit-by-digit", () => {
		expect(phonemesOf("42")).toEqual(["f", "ɔː", "r", "t", "uː"]);
		expect(phonemesOf("10")).toEqual(["w", "ʌ", "n", "z", "iː", "r", "oʊ"]);
	});
});

describe("mixed and hostile input", () => {
	it("splits words and digits out of mixed text", () => {
		expect(phonemesOf("hi42")).toEqual(["h", "ɪ", "f", "ɔː", "r", "t", "uː"]);
	});

	it("ignores punctuation and whitespace", () => {
		expect(phonemesOf("hello, world!")).toEqual([
			"h",
			"ə",
			"l",
			"oʊ",
			"w",
			"ɜː",
			"r",
			"l",
			"d",
		]);
	});

	it("returns no phonemes for non-alphanumeric input", () => {
		expect(phonemesOf("!!! --- ???")).toEqual([]);
		expect(phonemesOf("  ")).toEqual([]);
	});
});

describe("sourceTokenIndex propagation", () => {
	it("tags every phoneme with the originating token index", () => {
		const tokenizer = new RuleBasedEnglishPhonemeTokenizer();
		const phonemes = tokenizer.tokenize("hello world", 7);
		expect(phonemes.length).toBeGreaterThan(0);
		for (const phoneme of phonemes) {
			expect(phoneme.sourceTokenIndex).toBe(7);
		}
	});

	it("returns an empty array for empty tokens", () => {
		const tokenizer = new RuleBasedEnglishPhonemeTokenizer();
		expect(tokenizer.tokenize("", 3)).toEqual([]);
	});
});

describe("tokenizer identity", () => {
	it("exposes the stable name and quality for telemetry", () => {
		const tokenizer = createDefaultPhonemeTokenizer();
		expect(tokenizer.name).toBe("RuleBasedEnglishPhonemeTokenizer");
		expect(tokenizer.quality).toBe("approximate");
		expect(tokenizer).toBeInstanceOf(RuleBasedEnglishPhonemeTokenizer);
	});
});
