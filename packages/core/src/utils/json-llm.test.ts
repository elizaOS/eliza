/**
 * Tests for `extractAndParseJSONObjectFromText`, the core LLM-output JSON parser:
 * it turns a model's text into a structured object, so a regression here breaks
 * every structured model output. Deterministic — exercises the parser on fixed
 * strings, no live model.
 */
import { describe, expect, it } from "vitest";
import { extractAndParseJSONObjectFromText } from "./json-llm";

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

	it("parses a model JSON value beyond the former 100,000-character boundary", () => {
		const sentinel = "END_OF_COMPLETE_MODEL_OUTPUT";
		const value = `${"x".repeat(1_100_000)}${sentinel}`;
		expect(
			extractAndParseJSONObjectFromText(JSON.stringify({ value })),
		).toEqual({ value });
	});

	it("extracts JSON from a ```json fenced block surrounded by prose", () => {
		expect(
			extractAndParseJSONObjectFromText(
				'here you go:\n```json\n{"ok":true}\n```\nthanks',
			),
		).toEqual({ ok: true });
	});

	it("extracts JSON from a ```json5 fenced block", () => {
		// The helper parses with JSON5, so a model is free to label the fence
		// `json5`. The info string is not anchored, so a `json`-first alternation
		// matched only the first four characters and left the "5" at the head of
		// the capture, which JSON5.parse then rejected.
		expect(
			extractAndParseJSONObjectFromText("```json5\n{ ok: true, }\n```"),
		).toEqual({ ok: true });
	});

	it("extracts JSON from a ```JSON5 fenced block with CRLF line endings", () => {
		expect(
			extractAndParseJSONObjectFromText("```JSON5\r\n[1, 2, 3]\r\n```"),
		).toEqual([1, 2, 3]);
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

	it("throws when parsed JSON is a primitive scalar", () => {
		expect(() => extractAndParseJSONObjectFromText("null")).toThrow(
			/Failed to parse/,
		);
		expect(() => extractAndParseJSONObjectFromText("123")).toThrow(
			/Failed to parse/,
		);
		expect(() => extractAndParseJSONObjectFromText("true")).toThrow(
			/Failed to parse/,
		);
		expect(() => extractAndParseJSONObjectFromText('"just a string"')).toThrow(
			/Failed to parse/,
		);
	});
});
