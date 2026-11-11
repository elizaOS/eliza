import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { flattenTextValues } from "../src/utils/text-normalize.ts";

describe("flattenTextValues cross-realm Error", () => {
	it("flattens an Error from another realm as Name: message", () => {
		const ctx = vm.createContext({});
		const CrossRealmError = vm.runInContext(
			"Error",
			ctx,
		) as ErrorConstructor;
		const err = new CrossRealmError("boom");
		expect(err instanceof Error).toBe(false);
		expect(flattenTextValues(err)).toEqual(["Error: boom"]);
	});

	it("keeps a subclass name from another realm", () => {
		const ctx = vm.createContext({});
		const CrossRealmRangeError = vm.runInContext(
			"RangeError",
			ctx,
		) as ErrorConstructor;
		const err = new CrossRealmRangeError("too big");
		expect(flattenTextValues(err)).toEqual(["RangeError: too big"]);
	});

	it("still flattens a same-realm Error", () => {
		expect(flattenTextValues(new Error("boom"))).toEqual(["Error: boom"]);
		expect(flattenTextValues(new TypeError("bad type"))).toEqual([
			"TypeError: bad type",
		]);
	});
});
