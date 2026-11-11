import { describe, expect, it } from "vitest";
import {
	flattenTextValues,
	toMultilineText,
} from "../src/utils/text-normalize.ts";

describe("flattenTextValues with Map and Set", () => {
	it("flattens Map entries to key: value fragments", () => {
		expect(
			flattenTextValues(
				new Map([
					["a", "b"],
					["c", "d"],
				]),
			),
		).toEqual(["a: b", "c: d"]);
	});

	it("flattens Set values", () => {
		expect(flattenTextValues(new Set(["hello", "world"]))).toEqual([
			"hello",
			"world",
		]);
	});

	it("flattens a Map nested inside an object", () => {
		expect(
			flattenTextValues({ m: new Map([["k", "v"]]) }),
		).toEqual(["m: k: v"]);
		expect(toMultilineText({ tags: new Set(["a", "b"]) })).toBe(
			"tags: a, b",
		);
	});

	it("stringifies non-string Map keys", () => {
		expect(flattenTextValues(new Map([[1, "one"]]))).toEqual(["1: one"]);
	});

	it("drops Map entries with empty values", () => {
		expect(flattenTextValues(new Map([["a", ""]]))).toEqual([]);
		expect(flattenTextValues(new Map([["a", null]]))).toEqual([]);
	});

	it("does not loop on a self-referencing Map", () => {
		const cyclic = new Map<string, unknown>();
		cyclic.set("self", cyclic);
		expect(flattenTextValues(cyclic)).toEqual([]);
	});

	it("flattens a Set of nested arrays", () => {
		expect(flattenTextValues(new Set([["x", "y"]]))).toEqual(["x", "y"]);
	});

	it("keeps plain objects and arrays unchanged", () => {
		expect(flattenTextValues({ a: "b" })).toEqual(["a: b"]);
		expect(flattenTextValues(["x", "y"])).toEqual(["x", "y"]);
	});
});
