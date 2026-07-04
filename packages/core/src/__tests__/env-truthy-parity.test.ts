/**
 * Pins the canonical env-truthiness contract (isTruthyEnvValue) and checks the
 * boolean-parser wrappers (parseBooleanValue, parseBooleanText, readEnvBool)
 * each keep their documented truthy/falsy token sets. Pure deterministic parser
 * test.
 */
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../env-utils.js";
import { parseBooleanText, parseBooleanValue } from "../utils/boolean.js";
import { readEnvBool } from "../utils/read-env.js";

const CANONICAL_TRUTHY = ["1", "true", "yes", "y", "on", "enabled"] as const;

describe("isTruthyEnvValue (canonical)", () => {
	it("accepts exactly the canonical truthy tokens", () => {
		for (const token of CANONICAL_TRUTHY) {
			expect(isTruthyEnvValue(token)).toBe(true);
		}
	});

	it("is case-insensitive and trims surrounding whitespace", () => {
		for (const token of CANONICAL_TRUTHY) {
			expect(isTruthyEnvValue(token.toUpperCase())).toBe(true);
			expect(isTruthyEnvValue(`  ${token}  `)).toBe(true);
			expect(isTruthyEnvValue(`\t${token.toUpperCase()}\n`)).toBe(true);
		}
	});

	it("rejects non-canonical, empty, and nullish values", () => {
		for (const token of [
			"0",
			"false",
			"no",
			"off",
			"n",
			"disabled",
			"enable",
			"t",
			"truthy",
			"",
			"   ",
		]) {
			expect(isTruthyEnvValue(token)).toBe(false);
		}
		expect(isTruthyEnvValue(undefined)).toBe(false);
		expect(isTruthyEnvValue(null)).toBe(false);
	});
});

describe("parseBooleanValue (canonical 3-valued parser)", () => {
	it("uses the default truthy/falsy sets and returns undefined for unknown", () => {
		for (const token of ["true", "1", "yes", "on"]) {
			expect(parseBooleanValue(token)).toBe(true);
		}
		for (const token of ["false", "0", "no", "off"]) {
			expect(parseBooleanValue(token)).toBe(false);
		}
		expect(parseBooleanValue("maybe")).toBeUndefined();
		expect(parseBooleanValue(undefined)).toBeUndefined();
		expect(parseBooleanValue("")).toBeUndefined();
		expect(parseBooleanValue(true)).toBe(true);
		expect(parseBooleanValue(false)).toBe(false);
	});
});

describe("parseBooleanText (wrapper: text set, 2-valued, defaults false)", () => {
	it("accepts its documented truthy text tokens", () => {
		for (const token of ["yes", "y", "true", "t", "1", "on", "enable"]) {
			expect(parseBooleanText(token)).toBe(true);
		}
	});

	it("treats falsy and unknown text as false", () => {
		for (const token of ["no", "n", "false", "f", "0", "off", "disable"]) {
			expect(parseBooleanText(token)).toBe(false);
		}
		expect(parseBooleanText("garbage")).toBe(false);
		expect(parseBooleanText(undefined)).toBe(false);
		expect(parseBooleanText(null)).toBe(false);
	});
});

describe("readEnvBool (wrapper: default set, 2-valued, configurable default)", () => {
	it("preserves the 1/true/yes/on truthy and 0/false/no/off falsy sets", () => {
		for (const v of ["1", "true", "TRUE", "yes", "on"]) {
			expect(readEnvBool("ELIZA_FLAG", { env: { ELIZA_FLAG: v } })).toBe(true);
		}
		for (const v of ["0", "false", "no", "off"]) {
			expect(readEnvBool("ELIZA_FLAG", { env: { ELIZA_FLAG: v } })).toBe(false);
		}
	});

	it("returns defaultValue (default false) when unset or unrecognized", () => {
		expect(readEnvBool("ELIZA_FLAG", { env: {} })).toBe(false);
		expect(readEnvBool("ELIZA_FLAG", { env: {}, defaultValue: true })).toBe(
			true,
		);
		expect(readEnvBool("ELIZA_FLAG", { env: { ELIZA_FLAG: "maybe" } })).toBe(
			false,
		);
		expect(
			readEnvBool("ELIZA_FLAG", {
				env: { ELIZA_FLAG: "maybe" },
				defaultValue: true,
			}),
		).toBe(true);
	});
});
