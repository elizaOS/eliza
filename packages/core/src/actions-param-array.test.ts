/** Regression for JSON action-parameter Unicode coercion safety. */

import { describe, expect, it } from "vitest";
import { validateActionParams } from "./actions";
import type { Action } from "./types";

const ARRAY_ACTION = {
	name: "TAG_ITEMS",
	parameters: [
		{
			name: "tags",
			required: true,
			schema: { type: "array", items: { type: "string" } },
		},
	],
} as Action;

describe("JSON-array action parameter Unicode safety", () => {
	it("replaces lone surrogates while preserving valid astral pairs", () => {
		const result = validateActionParams(ARRAY_ACTION, {
			tags: '["\\ud800abc","\\ud83e\\udd8a"]',
		});

		expect(result).toMatchObject({ valid: true, errors: [] });
		expect(result.params?.tags).toEqual(["�abc", "🦊"]);
		expect(JSON.stringify(result.params)).toBe('{"tags":["�abc","🦊"]}');
	});
});
