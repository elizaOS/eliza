import { describe, expect, it } from "vitest";
import { normalizeCharacterInput, parseCharacter } from "../src/character";

describe("normalizeCharacterInput flat message examples", () => {
	it("wraps a flat list of message examples as one group", () => {
		const normalized = normalizeCharacterInput({
			name: "flat-examples",
			messageExamples: [
				{ name: "user", content: { text: "Hello" } },
				{ name: "agent", content: { text: "Hi there" } },
			],
		} as never);

		expect(normalized.messageExamples).toEqual([
			{
				examples: [
					{ name: "user", content: { text: "Hello" } },
					{ name: "agent", content: { text: "Hi there" } },
				],
			},
		]);
	});

	it("keeps grouped and nested example shapes unchanged", () => {
		const grouped = normalizeCharacterInput({
			name: "grouped-examples",
			messageExamples: [
				{
					examples: [{ name: "user", content: { text: "Hello" } }],
				},
			],
		});
		expect(grouped.messageExamples).toHaveLength(1);

		const nested = normalizeCharacterInput({
			name: "nested-examples",
			messageExamples: [
				[{ name: "user", content: { text: "Hello" } }],
				[{ name: "user", content: { text: "Bye" } }],
			],
		});
		expect(nested.messageExamples).toHaveLength(2);
	});

	it("still drops input that is not a message example", () => {
		const normalized = normalizeCharacterInput({
			name: "bad-examples",
			messageExamples: ["not-an-example"],
		} as never);

		expect(normalized.messageExamples).toEqual([]);
	});

	it("parses a character whose examples are a flat list", () => {
		const character = parseCharacter({
			name: "flat-examples-parse",
			messageExamples: [
				{ name: "user", content: { text: "Hello" } },
				{ name: "agent", content: { text: "Hi there" } },
			],
		} as never);

		expect(character.messageExamples).toHaveLength(1);
		expect(character.messageExamples?.[0]?.examples).toHaveLength(2);
	});
});
