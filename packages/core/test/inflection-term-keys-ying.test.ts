import { expect, test } from "vitest";
import { inflectionTermKeys } from "../src/utils/inflection-term-keys";

test("term matching keeps the ie form for ying present participle", () => {
	for (const [base, prog] of [
		["die", "dying"],
		["lie", "lying"],
		["tie", "tying"],
		["vie", "vying"],
	]) {
		const storedKeys = new Set(inflectionTermKeys(prog));
		expect(inflectionTermKeys(base).some((key) => storedKeys.has(key))).toBe(
			true,
		);
	}
});

test("term matching does not invent ie forms for vowel+y or cry verbs", () => {
	expect(inflectionTermKeys("playing")).not.toContain("plaie");
	expect(inflectionTermKeys("saying")).not.toContain("saie");
	expect(inflectionTermKeys("crying")).not.toContain("crie");
	expect(inflectionTermKeys("trying")).not.toContain("trie");
});
