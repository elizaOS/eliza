import { expect, test } from "vitest";
import { normalizeCharacterMessageExamples } from "../src/utils/character-message-examples";

test("character examples stop JSON before trailing prose", () => {
	const records = [
		{ role: "user", content: 'Hello [world] "quoted" \\ slash' },
	];
	for (const normalize of [normalizeCharacterMessageExamples]) {
		const expected = normalize(records);
		for (const value of [records, { messageExamples: records }, [records]]) {
			const json = JSON.stringify(value);
			for (const prefix of ["", "Examples: "]) {
				expect(normalize(`${prefix}${json} Note: [keep] {these}`)).toEqual(
					expected,
				);
			}
			expect(normalize(json)).toEqual(expected);
			expect(normalize(`\`\`\`json\r\n${json}\r\n\`\`\``)).toEqual(expected);
		}
		for (const input of [
			"not JSON",
			"[{broken] trailing ]",
			'{"messageExamples":"unterminated',
		]) {
			expect(normalize(input)).toEqual([]);
		}
	}
});

test("character examples accept a single group object", () => {
	const group = {
		examples: [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi" },
		],
	};
	const expected = [
		{
			examples: [
				{ name: "{{user1}}", content: { text: "Hello" } },
				{ name: "Agent", content: { text: "Hi" } },
			],
		},
	];
	expect(normalizeCharacterMessageExamples(group)).toEqual(expected);
	expect(normalizeCharacterMessageExamples(JSON.stringify(group))).toEqual(
		expected,
	);
	expect(normalizeCharacterMessageExamples({ messageExamples: group })).toEqual(
		expected,
	);
	expect(normalizeCharacterMessageExamples([group])).toEqual(expected);
});
