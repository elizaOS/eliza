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

	it("keeps a ``` inside a JSON string value as data (#30736)", () => {
		// Valid JSON that JSON.parse accepts. An unanchored fence match captured
		// the bare `bun test` between the two runs of backticks and failed.
		const text = '{"text":"Run ```bun test``` first","ok":true}';
		expect(extractAndParseJSONObjectFromText(text)).toEqual(JSON.parse(text));
	});

	it("extracts a fenced block from prose when a string value holds a code block (#30736)", () => {
		// The reply envelope: a JSON.stringify'd {thought, text} whose text
		// field carries a fenced snippet, wrapped in a ```json fence with prose
		// on both sides. The inner fence sits after an escaped \n, never at the
		// start of a line, so only the real closing fence ends the block.
		const value = {
			thought: "answer with the command",
			text: "Run this:\n```bash\nbun test\n```",
		};
		const text = `Sure:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\nHope that helps!`;
		expect(extractAndParseJSONObjectFromText(text)).toEqual(value);
	});

	it("extracts a whole-value fence when a string value holds a code block (#30736)", () => {
		const value = { text: "Run this:\n```bash\nbun test\n```" };
		expect(
			extractAndParseJSONObjectFromText(
				`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
			),
		).toEqual(value);
	});

	it("extracts JSON from a ```json5 fenced block, with LF or CRLF endings", () => {
		expect(
			extractAndParseJSONObjectFromText("```json5\n{ ok: true, }\n```"),
		).toEqual({ ok: true });
		expect(
			extractAndParseJSONObjectFromText("```JSON5\r\n[1, 2, 3]\r\n```"),
		).toEqual([1, 2, 3]);
		expect(
			extractAndParseJSONObjectFromText(
				"note:\r\n```json5\r\n{ ok: true, }\r\n```\r\nend",
			),
		).toEqual({ ok: true });
	});

	it("extracts a compact whole-value fence", () => {
		expect(extractAndParseJSONObjectFromText('```{"a":1}```')).toEqual({
			a: 1,
		});
	});

	it("uses the first fenced block when prose carries several", () => {
		expect(
			extractAndParseJSONObjectFromText(
				'first:\n```json\n{"n":1}\n```\nsecond:\n```json\n{"n":2}\n```',
			),
		).toEqual({ n: 1 });
	});

	it("reports the fenced content's error when the fenced block is invalid", () => {
		expect(() =>
			extractAndParseJSONObjectFromText("see:\n```json\n{not json\n```"),
		).toThrow(/Failed to parse/);
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
