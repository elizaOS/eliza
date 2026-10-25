import { expect, test } from "vitest";
import { inflectionTermKeys } from "../src/utils/inflection-term-keys";

test("term matching keeps the y form for ied past tense", () => {
	for (const [base, past] of [
		["study", "studied"],
		["carry", "carried"],
		["reply", "replied"],
		["try", "tried"],
	]) {
		const storedKeys = new Set(inflectionTermKeys(past));
		expect(inflectionTermKeys(base).some((key) => storedKeys.has(key))).toBe(
			true,
		);
	}
});
