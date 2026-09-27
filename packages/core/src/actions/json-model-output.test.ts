import { describe, expect, it } from "vitest";
import { parseJsonModelOutput } from "./json-model-output";

describe("parseJsonModelOutput reasoning preamble", () => {
	it.each([
		'<think>r</think>{"a":1}',
		'<think>maybe {a:1}?</think>{"a":1}',
		'<thinking>r</thinking>{"a":1}',
		'<reasoning>r</reasoning>{"a":1}',
		'<THINK>r</THINK>{"a":1}',
		'< think >r</ think >{"a":1}',
		'<think>r</think>```json\n{"a":1}\n```',
	])("strips a leading reasoning block from %j", (raw) => {
		expect(parseJsonModelOutput(raw)).toEqual({ a: 1 });
	});

	it.each([
		['{"text":"<think>hi</think>"}', { text: "<think>hi</think>" }],
		['{"a":1,"note":"</think> x"}', { a: 1, note: "</think> x" }],
		['"</think> x"', "</think> x"],
		['"<think>a</think>b"', "<think>a</think>b"],
		['```json\n{"n":"</think>"}\n```', { n: "</think>" }],
	])("leaves reasoning markup inside payload %j untouched", (raw, expected) => {
		expect(parseJsonModelOutput(raw)).toEqual(expected);
	});

	it("keeps an unclosed reasoning block so the parse fails closed", () => {
		expect(parseJsonModelOutput('<think>never closed {"a":1}')).toBeNull();
	});
});
