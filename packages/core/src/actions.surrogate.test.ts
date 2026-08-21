/** Surrogate safety for action parameter string array splitting in actions.ts. */
import { describe, expect, test } from "vitest";
import { validateActionParams } from "./actions.ts";
import type { Action } from "./types.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return true;
}

const testAction: Action = {
	name: "TEST_ACTION",
	description: "Test action for parameter parsing",
	similes: [],
	examples: [],
	parameters: [
		{
			name: "tags",
			description: "List of tags",
			required: false,
			schema: {
				type: "array",
				items: { type: "string" },
			},
		},
	],
	handler: async () => ({ success: true }),
};

describe("actions param array splitting surrogate safety", () => {
	test("emoji at 10000 boundary backs off cleanly without lone surrogate", () => {
		const fox = "🦊";
		const input = `${"a".repeat(9999)}${fox},${"b".repeat(500)}`;
		const res = validateActionParams(testAction, { tags: input });
		const tags = res.params?.tags as string[];
		expect(Array.isArray(tags)).toBe(true);
		tags.forEach((tag) => {
			expect(isWellFormed(tag)).toBe(true);
			expect(() => JSON.stringify({ tag })).not.toThrow();
		});
	});

	test("fitting emoji ending at 10000 kept intact", () => {
		const fox = "🦊";
		const input = `${"a".repeat(9998)}${fox}`;
		const res = validateActionParams(testAction, { tags: input });
		const tags = res.params?.tags as string[];
		expect(Array.isArray(tags)).toBe(true);
		expect(tags[0].includes(fox)).toBe(true);
		expect(isWellFormed(tags[0])).toBe(true);
	});

	test("lone high surrogate in delimited string is sanitized safely", () => {
		const badInput = "tag1, tag2 \ud800, tag3";
		const res = validateActionParams(testAction, { tags: badInput });
		const tags = res.params?.tags as string[];
		expect(Array.isArray(tags)).toBe(true);
		tags.forEach((tag) => {
			expect(isWellFormed(tag)).toBe(true);
			expect(tag.includes("\ud800")).toBe(false);
		});
	});

	test("sweep offsets around 10k cap all stay well-formed", () => {
		const fox = "🦊";
		for (let offset = -5; offset <= 5; offset++) {
			const n = 10_000 + offset;
			const input = `${"a".repeat(n)}${fox},other`;
			const res = validateActionParams(testAction, { tags: input });
			const tags = res.params?.tags as string[];
			expect(Array.isArray(tags)).toBe(true);
			tags.forEach((tag) => {
				expect(isWellFormed(tag)).toBe(true);
				expect(() => JSON.stringify({ tag })).not.toThrow();
			});
		}
	});
});
