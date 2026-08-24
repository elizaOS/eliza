import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "./env-utils.js";

describe("isTruthyEnvValue", () => {
	it("returns true for truthy strings case-insensitive", () => {
		expect(isTruthyEnvValue("1")).toBe(true);
		expect(isTruthyEnvValue("true")).toBe(true);
		expect(isTruthyEnvValue("TRUE")).toBe(true);
		expect(isTruthyEnvValue("yes")).toBe(true);
		expect(isTruthyEnvValue("on")).toBe(true);
		expect(isTruthyEnvValue("enabled")).toBe(true);
		expect(isTruthyEnvValue("y")).toBe(true);
	});

	it("trims and lowercases before check", () => {
		expect(isTruthyEnvValue("  true  ")).toBe(true);
		expect(isTruthyEnvValue(" YES ")).toBe(true);
	});

	it("returns false for falsy and non-string", () => {
		expect(isTruthyEnvValue("0")).toBe(false);
		expect(isTruthyEnvValue("false")).toBe(false);
		expect(isTruthyEnvValue("")).toBe(false);
		expect(isTruthyEnvValue(undefined)).toBe(false);
		expect(isTruthyEnvValue(null)).toBe(false);
		expect(isTruthyEnvValue("nope")).toBe(false);
	});
});
