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
	factClaimsEquivalent,
	factLexicalSimilarity,
	factPolarityDiffers,
	tokenizeFactText,
} from "./fact-keywords.ts";

describe("factClaimsEquivalent", () => {
	it.each([
		["prefers oat milk in coffee", "User prefers oat milk in their coffee."],
		["prefers morning check-ins", "the user prefers morning check-ins"],
		[
			"Prefers sparkling water over still water",
			"prefers sparkling water over still water",
		],
	])("accepts %j and %j as the identical claim", (left, right) => {
		expect(factClaimsEquivalent(left, right)).toBe(true);
	});

	it.each([
		["previously liked oat milk", "nowadays likes oat milk"],
		["used to hate oat milk", "does not hate oat milk"],
		["prefers oat milk in coffee", "loves oat milk in coffee"],
		["prefers oat milk in coffee", "prefers oat milk in cereal"],
		["prefers oat milk", "prefers oat milk in coffee"],
		["likes oat milk", "does not like oat milk"],
		["", "prefers oat milk"],
	])("keeps %j and %j as separate claims", (left, right) => {
		expect(factClaimsEquivalent(left, right)).toBe(false);
	});
});

describe("factPolarityDiffers", () => {
	it.each([
		["likes oat milk", "does not like oat milk"],
		["likes oat milk", "doesn’t like oat milk"],
		["used to hate oat milk", "does not hate oat milk"],
		["used to prefer oat milk", "prefers oat milk"],
		["prefers oat milk", "no longer prefers oat milk"],
		["hates mornings", "never hated mornings"],
	])("treats %j and %j as different claims", (left, right) => {
		expect(factPolarityDiffers(left, right)).toBe(true);
		expect(factPolarityDiffers(right, left)).toBe(true);
	});

	it.each([
		["does not like oat milk", "dislikes oat milk"],
		["prefers oat milk in coffee", "User prefers oat milk in their coffee."],
		["never liked oat milk", "does not like oat milk"],
		["used to live in Berlin", "previously lived in Berlin"],
	])("treats %j and %j as compatible claims", (left, right) => {
		expect(factPolarityDiffers(left, right)).toBe(false);
	});
});

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
