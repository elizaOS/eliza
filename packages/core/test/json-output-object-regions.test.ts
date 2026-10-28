/**
 * A model reply often explains the shape before it writes the object:
 * `Use {name as a placeholder, then ...` or `Use {name} for the title`. The
 * prose must not hide the object, and the object after it must still be read.
 */
import { describe, expect, it } from "vitest";

import { parseJsonObject } from "../src/runtime/json-output";
import { parseAndValidate } from "../src/runtime/validated-model-call";

const DRAFT = { version: 1, name: "Morning", operations: ["notes.create"] };
const DRAFT_TEXT = JSON.stringify(DRAFT);

const SCHEMA = {
	type: "object",
	properties: {
		version: { type: "number" },
		name: { type: "string" },
		operations: { type: "array", items: { type: "string" } },
	},
	required: ["version", "name"],
	additionalProperties: true,
};

describe("parseJsonObject object regions after prose", () => {
	it("reads the object after a prose brace that never closes", () => {
		expect(
			parseJsonObject(
				`Use {name as a placeholder, then create this draft:\n${DRAFT_TEXT}`,
			),
		).toEqual(DRAFT);
	});

	it("skips a prose region that is not JSON", () => {
		expect(
			parseJsonObject(`Use {name} for the title, then:\n${DRAFT_TEXT}`),
		).toEqual(DRAFT);
	});

	it("reads the object after a quote that only frames a word", () => {
		expect(
			parseJsonObject(`The label is 5" wide, then:\n${DRAFT_TEXT}`),
		).toEqual(DRAFT);
	});

	it("still reads the first complete object when two are present", () => {
		expect(parseJsonObject('{"a":1}\n{"b":2}')).toEqual({ a: 1 });
	});

	it("validates the recovered object against the schema", () => {
		const result = parseAndValidate(
			`Use {name as a placeholder, then create this draft:\n${DRAFT_TEXT}`,
			SCHEMA,
		);
		expect(result.valid).toBe(true);
		expect(result.parsed).toEqual(DRAFT);
	});
});
