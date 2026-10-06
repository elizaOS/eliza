import { describe, expect, it } from "vitest";
import { unwrapWholeCodeFence } from "../src/markdown/code.ts";
import { parseJsonObject } from "../src/runtime/json-output.ts";

const languages = ["json", "json5"];

describe("unwrapWholeCodeFence", () => {
	it("unwraps a three-backtick json fence", () => {
		expect(unwrapWholeCodeFence('```json\n{"a":1}\n```', languages)).toBe(
			'{"a":1}',
		);
	});

	it.each([4, 6])("unwraps a %s-backtick fence", (length) => {
		const fence = "`".repeat(length);
		expect(unwrapWholeCodeFence(`${fence}\n{"a":1}\n${fence}`, languages)).toBe(
			'{"a":1}',
		);
		expect(
			unwrapWholeCodeFence(`${fence}json\n{"a":1}\n${fence}`, languages),
		).toBe('{"a":1}');
	});

	it("keeps compact unlabeled fences", () => {
		expect(unwrapWholeCodeFence("```true```", languages)).toBe("true");
		expect(unwrapWholeCodeFence("```name: value```", languages)).toBe(
			"name: value",
		);
	});

	it("returns null unless the value ends in a matching closer", () => {
		expect(
			unwrapWholeCodeFence('```json\n{"a":1}\nnot a fence', languages),
		).toBeNull();
		expect(
			unwrapWholeCodeFence('```json\n{"a":1}\n``` trailing', languages),
		).toBeNull();
		expect(unwrapWholeCodeFence("```\nline\n``` ", languages)).toBeNull();
		expect(unwrapWholeCodeFence("plain text", languages)).toBeNull();
		expect(
			unwrapWholeCodeFence("```python\nprint(1)\n```", languages),
		).toBeNull();
	});
});

describe("parseJsonObject fence boundary", () => {
	it("reads a longer fence as the object", () => {
		expect(parseJsonObject('````\n{"a":1}\n````')).toEqual({ a: 1 });
	});

	it("does not parse a truncated object when the reply only starts with a fence", () => {
		expect(parseJsonObject('```\n{"a":12345}')).toEqual({ a: 12345 });
	});
});
