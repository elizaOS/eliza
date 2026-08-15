/**
 * Deterministic unit coverage for the prompt/context text-normalization
 * helpers. Both functions are pure, so every case is an exact input/output
 * assertion.
 *
 * These build the text blocks that reach model prompts, so the coercion rules
 * are the contract: which values survive, which are silently dropped, and how a
 * nested value is rendered. The drops are the part worth pinning — a value that
 * disappears here disappears from the prompt with no error, and the rule is
 * "empty after coercion", not "falsy": `0` and `false` are kept while `{}`,
 * `null` and a whitespace-only string are not.
 */

import { describe, expect, it } from "vitest";
import { flattenTextValues, toMultilineText } from "./text-normalize";

describe("flattenTextValues", () => {
	describe("strings", () => {
		it("trims and keeps a non-empty string", () => {
			expect(flattenTextValues("  hello  ")).toEqual(["hello"]);
		});

		it("drops an empty or whitespace-only string", () => {
			expect(flattenTextValues("")).toEqual([]);
			expect(flattenTextValues("   \n\t ")).toEqual([]);
		});
	});

	describe("nullish", () => {
		it("drops null and undefined, keeping their siblings", () => {
			expect(flattenTextValues(null)).toEqual([]);
			expect(flattenTextValues(undefined)).toEqual([]);
			expect(flattenTextValues([null, "a", undefined, "b"])).toEqual([
				"a",
				"b",
			]);
		});
	});

	describe("scalars", () => {
		it("keeps falsy-but-present scalars", () => {
			// The rule is "empty after coercion", not "falsy" — dropping these would
			// silently remove a real 0 or false from a prompt.
			expect(flattenTextValues(0)).toEqual(["0"]);
			expect(flattenTextValues(false)).toEqual(["false"]);
			expect(flattenTextValues([0, false])).toEqual(["0", "false"]);
		});

		it("stringifies other scalars", () => {
			expect(flattenTextValues(42)).toEqual(["42"]);
			expect(flattenTextValues(Number.NaN)).toEqual(["NaN"]);
			expect(flattenTextValues(true)).toEqual(["true"]);
		});
	});

	describe("arrays", () => {
		it("flattens arbitrarily nested arrays in order", () => {
			expect(flattenTextValues(["a", ["b", ["c", ["d"]]]])).toEqual([
				"a",
				"b",
				"c",
				"d",
			]);
		});

		it("yields nothing for an empty array or an array of empties", () => {
			expect(flattenTextValues([])).toEqual([]);
			expect(flattenTextValues([null, "", [], "  "])).toEqual([]);
		});
	});

	describe("objects", () => {
		it("renders each entry as `key: value`", () => {
			expect(flattenTextValues({ a: "1", b: "2" })).toEqual(["a: 1", "b: 2"]);
		});

		it("joins a nested collection into one entry with `, `", () => {
			expect(flattenTextValues({ tags: ["x", "y"] })).toEqual(["tags: x, y"]);
			expect(flattenTextValues({ outer: { inner: "v" } })).toEqual([
				"outer: inner: v",
			]);
		});

		it("drops an entry whose value coerces to nothing", () => {
			expect(flattenTextValues({ a: {}, b: null, c: "  ", d: [] })).toEqual([]);
			expect(flattenTextValues({ kept: "v", dropped: null })).toEqual([
				"kept: v",
			]);
		});

		it("keeps an entry whose value is a falsy scalar", () => {
			expect(flattenTextValues({ count: 0, on: false })).toEqual([
				"count: 0",
				"on: false",
			]);
		});
	});

	describe("non-plain objects have no enumerable own entries and are dropped", () => {
		// Worth pinning: these coerce to nothing rather than to their toString(),
		// so a Date or Map handed to prompt assembly vanishes without an error.
		it.each([
			["a Date", new Date("2026-01-01T00:00:00.000Z")],
			["a Map", new Map([["k", "v"]])],
			["a Set", new Set(["a"])],
		])("drops %s", (_label, value) => {
			expect(flattenTextValues(value)).toEqual([]);
		});
	});
});

describe("toMultilineText", () => {
	it("joins the flattened fragments with newlines", () => {
		expect(toMultilineText({ a: "1", b: "2" })).toBe("a: 1\nb: 2");
		expect(toMultilineText(["x", ["y", "z"]])).toBe("x\ny\nz");
	});

	it("returns an empty string when nothing survives", () => {
		expect(toMultilineText(null)).toBe("");
		expect(toMultilineText([null, "  ", {}])).toBe("");
	});
});
