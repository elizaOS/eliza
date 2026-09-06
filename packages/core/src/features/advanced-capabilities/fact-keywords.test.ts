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
		["prefers oat milk in coffee", "User prefers oat milk in coffee."],
		["prefers morning check-ins", "the user prefers morning check-ins"],
		[
			"Prefers sparkling water over still water",
			"prefers  sparkling water over still water",
		],
		["doesn’t like oat milk", "doesn't like oat milk"],
		["likes 茶", "User likes 茶."],
		["knows C++", "The user knows C++"],
	])("accepts %j and %j as the identical claim", (left, right) => {
		expect(factClaimsEquivalent(left, right)).toBe(true);
	});

	it.each([
		["likes 茶", "likes 咖啡"],
		["knows C++", "knows C"],
		["rates A > B", "rates A < B"],
		["prefers oat milk in coffee", "User prefers oat milk in their coffee."],
		["prefers tea over coffee", "prefers coffee over tea"],
		["reports to Alice, manages Bob", "reports to Bob, manages Alice"],
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

describe("factClaimsEquivalent: possessive and first-person subject references", () => {
	it('treats "the user\'s", "user\'s", and "my" as the row\'s own subject', () => {
		// Live 2026-09-06: the MEMORY action stored "The user's favorite tea is
		// hojicha", Stage-1 kept "favorite tea is hojicha"; both rows persisted
		// and the next "forget my favorite tea" was ambiguous.
		expect(
			factClaimsEquivalent(
				"The user's favorite tea is hojicha",
				"favorite tea is hojicha",
			),
		).toBe(true);
		expect(
			factClaimsEquivalent(
				"user's favorite tea is genmaicha",
				"The user's favorite tea is genmaicha.",
			),
		).toBe(true);
		expect(
			factClaimsEquivalent("my sister is Dana", "user's sister is Dana"),
		).toBe(true);
	});

	it("does not strip those words when they are not the leading subject", () => {
		expect(factClaimsEquivalent("sister is Dana", "Dana is my sister")).toBe(
			false,
		);
		expect(
			factClaimsEquivalent(
				"favorite tea is hojicha",
				"favorite tea is not hojicha",
			),
		).toBe(false);
		expect(
			factClaimsEquivalent(
				"the user's favorite tea is hojicha",
				"the user's favorite tea is genmaicha",
			),
		).toBe(false);
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
