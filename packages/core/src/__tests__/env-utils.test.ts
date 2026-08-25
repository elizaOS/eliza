import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../env-utils.ts";

describe("isTruthyEnvValue", () => {
	it("accepts truthy vocabularies", () => {
		for (const v of [
			"1",
			"true",
			"yes",
			"y",
			"on",
			"enabled",
			" TRUE ",
			" yes ",
		]) {
			expect(isTruthyEnvValue(v)).toBe(true);
		}
	});

	it("rejects falsy and junk", () => {
		for (const v of ["0", "false", "no", "n", "off", "disabled", "maybe", ""]) {
			expect(isTruthyEnvValue(v)).toBe(false);
		}
	});

	it("handles non-strings", () => {
		expect(isTruthyEnvValue(null)).toBe(false);
		expect(isTruthyEnvValue(undefined)).toBe(false);
	});
});
