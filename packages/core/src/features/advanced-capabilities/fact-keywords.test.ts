/**
 * Unit tests (deterministic, no runtime) for the fact keyword tooling behind
 * lexical fact retrieval. Tokenization strips punctuation/stopwords, splits
 * hyphens, and applies length floors; extraction dedupes + ranks by frequency;
 * lexical similarity blends coverage + jaccard (1.0 for identical keyword sets,
 * 0 for disjoint).
 */
import { describe, expect, it } from "vitest";
import {
	buildFactQueryText,
	extractFactKeywords,
	factLexicalSimilarity,
	tokenizeFactText,
} from "./fact-keywords.ts";

describe("tokenizeFactText", () => {
	it("lowercases, strips punctuation/stopwords, splits hyphens, floors length", () => {
		expect(tokenizeFactText("The quick brown fox")).toEqual([
			"quick",
			"brown",
			"fox",
		]);
		expect(tokenizeFactText("Hello, World!")).toEqual(["hello", "world"]);
		expect(tokenizeFactText("well-known facts")).toEqual([
			"well",
			"known",
			"facts",
		]);
		// "a"/"ok" too short; "5" single digit dropped; "42" kept.
		expect(tokenizeFactText("a 5 42 ok")).toEqual(["42"]);
	});
});

describe("extractFactKeywords / buildFactQueryText", () => {
	it("dedupes and ranks by frequency", () => {
		expect(extractFactKeywords("cat dog cat")).toEqual(["cat", "dog"]);
		expect(buildFactQueryText("Quick brown")).toBe("quick brown");
	});
});

describe("factLexicalSimilarity", () => {
	it("scores identical=1, disjoint=0, empty=0, partial in between", () => {
		expect(
			factLexicalSimilarity(["apple banana cherry"], ["apple banana cherry"]),
		).toBeCloseTo(1);
		expect(factLexicalSimilarity(["apple"], ["zulu"])).toBe(0);
		expect(factLexicalSimilarity([], ["apple"])).toBe(0);
		const partial = factLexicalSimilarity(["apple banana"], ["apple cherry"]);
		expect(partial).toBeGreaterThan(0);
		expect(partial).toBeLessThan(1);
	});
});
