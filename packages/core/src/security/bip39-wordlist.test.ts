/**
 * The BIP-39 wordlist module backs the seed-phrase detector: a candidate must
 * be all-BIP-39 words AND pass the trailing SHA-256 checksum, so an ordinary
 * English sentence of common words is rejected. These tests pin the canonical
 * list invariants (2048 sorted unique words), the real checksum vectors for
 * every validation branch (word-count gate, unknown word, checksum mismatch,
 * normalization), and the non-overlapping sliding-window finder including its
 * whitespace-adjacency guard.
 */

import { describe, expect, it } from "vitest";
import {
	BIP39_WORD_INDEX,
	BIP39_WORD_SET,
	BIP39_WORDLIST,
	findAllMnemonicPhrases,
	findMnemonicPhrase,
	mnemonicValid,
} from "./bip39-wordlist.ts";

const CANONICAL_ZERO_ENTROPY =
	"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ALL_ZOO = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";
const MIXED_WORDS =
	"fog spot notable regret pizza coffee harvest ensure fog spot notable reflect";
const FIFTEEN_WORDS =
	"drastic bamboo mountain loyal category cancel animal embark drastic bamboo mountain loyal category cancel apart";

describe("BIP39_WORDLIST", () => {
	it("contains exactly 2048 words", () => {
		expect(BIP39_WORDLIST).toHaveLength(2048);
	});

	it("is in canonical strictly ascending alphabetical order", () => {
		for (let i = 1; i < BIP39_WORDLIST.length; i += 1) {
			if (!(BIP39_WORDLIST[i - 1] < BIP39_WORDLIST[i])) {
				throw new Error(
					`not strictly ascending at ${i}: ${BIP39_WORDLIST[i - 1]} !< ${BIP39_WORDLIST[i]}`,
				);
			}
		}
	});

	it("starts and ends with the known boundary words", () => {
		expect(BIP39_WORDLIST[0]).toBe("abandon");
		expect(BIP39_WORDLIST[2047]).toBe("zoo");
	});
});

describe("BIP39_WORD_SET", () => {
	it("holds every wordlist entry without duplicates", () => {
		expect(BIP39_WORD_SET.size).toBe(2048);
	});

	it("membership matches the wordlist for known words and rejects near-misses", () => {
		expect(BIP39_WORD_SET.has("about")).toBe(true);
		expect(BIP39_WORD_SET.has("zoo")).toBe(true);
		expect(BIP39_WORD_SET.has("abduct")).toBe(false);
		expect(BIP39_WORD_SET.has("ABOUT")).toBe(false);
		expect(BIP39_WORD_SET.has("")).toBe(false);
	});
});

describe("BIP39_WORD_INDEX", () => {
	it("maps every word to its canonical position", () => {
		expect(BIP39_WORD_INDEX.size).toBe(2048);
		expect(BIP39_WORD_INDEX.get("abandon")).toBe(0);
		expect(BIP39_WORD_INDEX.get("about")).toBe(3);
		expect(BIP39_WORD_INDEX.get("zoo")).toBe(2047);
	});
});

describe("mnemonicValid", () => {
	it.each([
		["canonical zero-entropy 12-word vector", CANONICAL_ZERO_ENTROPY],
		["12-word vector from all-0xff entropy", ALL_ZOO],
		["12-word vector from mixed entropy", MIXED_WORDS],
		["15-word vector (160-bit entropy)", FIFTEEN_WORDS],
	])("accepts $title", (_title, phrase) => {
		expect(mnemonicValid(phrase)).toBe(true);
	});

	it("normalizes casing, leading/trailing whitespace, and runs of spaces", () => {
		expect(mnemonicValid(CANONICAL_ZERO_ENTROPY.toUpperCase())).toBe(true);
		expect(mnemonicValid(`  ${CANONICAL_ZERO_ENTROPY}  `)).toBe(true);
		expect(mnemonicValid(CANONICAL_ZERO_ENTROPY.split(" ").join("\t "))).toBe(
			true,
		);
	});

	it("rejects an in-wordlist phrase whose checksum bits do not match", () => {
		const badChecksum = `${CANONICAL_ZERO_ENTROPY.split(" ").slice(0, 11).join(" ")} abandon`;
		expect(badChecksum.split(" ").every((w) => BIP39_WORD_SET.has(w))).toBe(
			true,
		);
		expect(mnemonicValid(badChecksum)).toBe(false);
	});

	it("rejects a phrase containing a word outside the wordlist", () => {
		const unknownWord = CANONICAL_ZERO_ENTROPY.replace("about", "abduct");
		expect(BIP39_WORD_SET.has("abduct")).toBe(false);
		expect(mnemonicValid(unknownWord)).toBe(false);
	});

	it.each([
		["11 words", CANONICAL_ZERO_ENTROPY.split(" ").slice(0, 11).join(" ")],
		["13 words", `${CANONICAL_ZERO_ENTROPY} zoo`],
		["empty string", ""],
		["single word", "abandon"],
		["whitespace-only", "   "],
	])("rejects invalid word count: $title", (_title, phrase) => {
		expect(mnemonicValid(phrase)).toBe(false);
	});
});

describe("findAllMnemonicPhrases", () => {
	it("returns an empty array for empty or mnemonic-free text", () => {
		expect(findAllMnemonicPhrases("")).toEqual([]);
		expect(findAllMnemonicPhrases("nothing to see here at all")).toEqual([]);
	});

	it("locates one embedded phrase with its exact substring bounds", () => {
		const text = `my seed: ${CANONICAL_ZERO_ENTROPY} please keep safe`;
		expect(findAllMnemonicPhrases(text)).toEqual([
			{ value: CANONICAL_ZERO_ENTROPY, start: 9, end: 102 },
		]);
	});

	it("finds two adjacent phrases in one token run without overlap", () => {
		const text = `${ALL_ZOO} ${CANONICAL_ZERO_ENTROPY}`;
		expect(findAllMnemonicPhrases(text)).toEqual([
			{ value: ALL_ZOO, start: 0, end: 49 },
			{ value: CANONICAL_ZERO_ENTROPY, start: 50, end: 143 },
		]);
	});

	it("does not bridge words separated by punctuation instead of whitespace", () => {
		expect(
			findAllMnemonicPhrases(CANONICAL_ZERO_ENTROPY.split(" ").join("-")),
		).toEqual([]);
	});
});

describe("findMnemonicPhrase", () => {
	it("returns the first detected phrase value", () => {
		expect(findMnemonicPhrase(`seed is ${CANONICAL_ZERO_ENTROPY} ok`)).toBe(
			CANONICAL_ZERO_ENTROPY,
		);
		expect(
			findMnemonicPhrase(`${ALL_ZOO} then ${CANONICAL_ZERO_ENTROPY}`),
		).toBe(ALL_ZOO);
	});

	it("returns null when no valid phrase exists", () => {
		expect(findMnemonicPhrase("")).toBeNull();
		expect(
			findMnemonicPhrase(
				CANONICAL_ZERO_ENTROPY.split(" ").slice(0, 6).join(" "),
			),
		).toBeNull();
	});
});
