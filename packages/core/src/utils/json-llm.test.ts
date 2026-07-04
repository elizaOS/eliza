import { describe, expect, it } from "vitest";
import { extractAndParseJSONObjectFromText } from "./json-llm";

/**
 * Tests for `extractAndParseJSONObjectFromText`, the core LLM-output JSON parser
 * (#8801 / #9943): it turns a model's text into a structured object, so a
 * regression here breaks every structured model output.
 */
describe("extractAndParseJSONObjectFromText", () => {
	it("parses a plain JSON object", () => {
		expect(extractAndParseJSONObjectFromText('{"a":1,"b":"two"}')).toEqual({
			a: 1,
			b: "two",
		});
	});

	it("parses a JSON array", () => {
		expect(extractAndParseJSONObjectFromText("[1, 2, 3]")).toEqual([1, 2, 3]);
	});

	it("extracts JSON from a ```json fenced block surrounded by prose", () => {
		expect(
			extractAndParseJSONObjectFromText(
				'here you go:\n```json\n{"ok":true}\n```\nthanks',
			),
		).toEqual({ ok: true });
	});

	it("accepts JSON5 leniency (unquoted keys, single quotes, trailing comma)", () => {
		expect(extractAndParseJSONObjectFromText("{ a: 1, b: 'two', }")).toEqual({
			a: 1,
			b: "two",
		});
	});

	it("throws on empty / non-string input", () => {
		expect(() => extractAndParseJSONObjectFromText("")).toThrow(
			/non-empty string/,
		);
	});

	it("throws on unparseable text", () => {
		expect(() =>
			extractAndParseJSONObjectFromText("this is not json at all"),
		).toThrow(/Failed to parse/);
	});
});
