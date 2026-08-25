/**
 * Coverage for context-id normalization: canonical id list, lowercasing and
 * underscore folding, alias expansion, and de-duplication of mixed lists.
 */
import { describe, expect, it } from "vitest";
import {
	CONTEXT_ALIASES,
	expandContextAliases,
	FIRST_PARTY_CONTEXT_IDS,
	normalizeContextId,
	normalizeContextList,
} from "./context-normalization.ts";

describe("FIRST_PARTY_CONTEXT_IDS", () => {
	it("includes canonical ids and stays unique", () => {
		expect(FIRST_PARTY_CONTEXT_IDS).toContain("finance");
		expect(FIRST_PARTY_CONTEXT_IDS).toContain("crypto");
		expect(FIRST_PARTY_CONTEXT_IDS).toContain("admin");
		expect(new Set(FIRST_PARTY_CONTEXT_IDS).size).toBe(
			FIRST_PARTY_CONTEXT_IDS.length,
		);
	});
});

describe("normalizeContextId", () => {
	it("lowercases and trims", () => {
		expect(normalizeContextId("  Finance ")).toBe("finance");
		expect(normalizeContextId("CRYPTO")).toBe("crypto");
	});

	it("folds spaces and hyphens into underscores", () => {
		expect(normalizeContextId("screen time")).toBe("screen_time");
		expect(normalizeContextId("screen-time")).toBe("screen_time");
		expect(normalizeContextId("social posting")).toBe("social_posting");
	});
});

describe("expandContextAliases", () => {
	it("returns the normalized id when not an alias", () => {
		expect(expandContextAliases("finance")).toEqual(["finance"]);
		expect(expandContextAliases("  research ")).toEqual(["research"]);
	});

	it("expands money aliases to the canonical set", () => {
		expect(expandContextAliases("money")).toEqual([
			"finance",
			"wallet",
			"crypto",
		]);
		expect(expandContextAliases("balances")).toEqual([
			"finance",
			"wallet",
			"crypto",
		]);
	});

	it("expands web3 and defi aliases", () => {
		expect(expandContextAliases("web3")).toEqual([
			"crypto",
			"wallet",
			"finance",
		]);
		expect(expandContextAliases("defi")).toEqual([
			"crypto",
			"wallet",
			"finance",
		]);
	});

	it("normalizes the alias key before lookup", () => {
		expect(expandContextAliases("  Money ")).toEqual([
			"finance",
			"wallet",
			"crypto",
		]);
	});
});

describe("CONTEXT_ALIASES", () => {
	it("is frozen so aliases cannot be mutated", () => {
		expect(Object.isFrozen(CONTEXT_ALIASES)).toBe(true);
	});
});

describe("normalizeContextList", () => {
	it("returns an empty list for empty input", () => {
		expect(normalizeContextList(undefined)).toEqual([]);
		expect(normalizeContextList([])).toEqual([]);
	});

	it("normalizes and de-duplicates mixed input", () => {
		expect(normalizeContextList(["Finance", "finance", "CRYPTO"])).toEqual([
			"finance",
			"crypto",
		]);
	});

	it("expands aliases and merges duplicates", () => {
		expect(normalizeContextList(["money", "wallet", "finance"])).toEqual([
			"finance",
			"wallet",
			"crypto",
		]);
	});
});
