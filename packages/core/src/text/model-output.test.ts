/** A ```json5 fence must yield its body, not the "5" left over after a
 * shorter ```json label match. */
import { describe, expect, it } from "vitest";
import {
	extractAndParseJSONObjectFromText,
	parseJSONObjectFromText,
} from "./model-output";

describe("model-output code fences", () => {
	it.each([
		["json5", '```json5\n{"a": 1}\n```', { a: 1 }],
		[
			"json5 with JSON5-only syntax",
			"```json5\n{a: 1, b: 'x',}\n```",
			{ a: 1, b: "x" },
		],
		["uppercase JSON5", '```JSON5\n{"a": 1}\n```', { a: 1 }],
		["json", '```json\n{"a": 1}\n```', { a: 1 }],
		["unlabeled", '```\n{"a": 1}\n```', { a: 1 }],
	])("parses an object from a %s fence", (_label, text, expected) => {
		expect(parseJSONObjectFromText(text)).toEqual(expected);
	});

	it("extracts an array from a json5 fence without throwing", () => {
		expect(extractAndParseJSONObjectFromText("```json5\n[1, 2,]\n```")).toEqual(
			[1, 2],
		);
	});
});
