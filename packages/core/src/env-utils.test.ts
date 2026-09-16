/** Exercises accepted environment flags and rejection of empty or unknown input. */
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "./env-utils.js";

describe("isTruthyEnvValue", () => {
	it.each(["1", "true", "yes", "y", "on", "enabled"])(
		"accepts %s regardless of case or surrounding whitespace",
		(value) => {
			expect(isTruthyEnvValue(value)).toBe(true);
			expect(isTruthyEnvValue(`  ${value.toUpperCase()}  `)).toBe(true);
		},
	);

	it.each([
		"0",
		"false",
		"no",
		"n",
		"off",
		"disabled",
		"maybe",
		"2",
		"",
		"   ",
		null,
		undefined,
	])("rejects %j", (value) => expect(isTruthyEnvValue(value)).toBe(false));
});
