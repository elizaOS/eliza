/**
 * Coverage for env-utils.
 */
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "./env-utils.js";

describe("isTruthyEnvValue", () => {
	it("returns true for truthy values", () => {
		expect(isTruthyEnvValue("1")).toBe(true);
		expect(isTruthyEnvValue("true")).toBe(true);
		expect(isTruthyEnvValue("TRUE")).toBe(true);
		expect(isTruthyEnvValue("yes")).toBe(true);
		expect(isTruthyEnvValue(" on ")).toBe(true);
		expect(isTruthyEnvValue("enabled")).toBe(true);
		expect(isTruthyEnvValue("y")).toBe(true);
	});
	it("returns false for falsy and empty", () => {
		expect(isTruthyEnvValue("0")).toBe(false);
		expect(isTruthyEnvValue("false")).toBe(false);
		expect(isTruthyEnvValue("")).toBe(false);
		expect(isTruthyEnvValue("   ")).toBe(false);
		expect(isTruthyEnvValue(undefined)).toBe(false);
		expect(isTruthyEnvValue(null)).toBe(false);
	});
	it("trims and lowercases", () => {
		expect(isTruthyEnvValue(" True ")).toBe(true);
		expect(isTruthyEnvValue("YES")).toBe(true);
	});
	it("rejects unknown", () => {
		expect(isTruthyEnvValue("maybe")).toBe(false);
		expect(isTruthyEnvValue("2")).toBe(false);
	});
});
