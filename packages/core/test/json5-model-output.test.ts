import { describe, expect, it } from "vitest";
import {
	extractAndParseJSONObjectFromText,
	parseJSONObjectFromText,
} from "../src/utils/json5-model-output";

describe("parseJSONObjectFromText code fences", () => {
	it("reads a json5 fence instead of leaving the label's trailing 5 in the body", () => {
		expect(parseJSONObjectFromText("```json5\n{a: 1,}\n```")).toEqual({
			a: 1,
		});
		expect(parseJSONObjectFromText('```JSON5\n{"a": 1}\n```')).toEqual({
			a: 1,
		});
		expect(parseJSONObjectFromText('```json5{"a":1}```')).toEqual({ a: 1 });
		expect(
			parseJSONObjectFromText("prefix ```json5\n{ok: true}\n``` suffix"),
		).toEqual({ ok: true });
	});

	it("still reads json fences, unlabeled fences, and bare JSON5 objects", () => {
		expect(parseJSONObjectFromText('```json\n{"n": 5}\n```')).toEqual({
			n: 5,
		});
		expect(parseJSONObjectFromText("```json\n{a:1,}\n```")).toEqual({ a: 1 });
		expect(parseJSONObjectFromText("```\n{a:1}\n```")).toEqual({ a: 1 });
		expect(parseJSONObjectFromText("{a:1,}")).toEqual({ a: 1 });
		expect(parseJSONObjectFromText('```json\r\n{"a":1}\r\n```')).toEqual({
			a: 1,
		});
	});

	it("does not treat a longer label as json or json5", () => {
		expect(parseJSONObjectFromText("```json50\n{a:1}\n```")).toBeNull();
		expect(parseJSONObjectFromText('```jsonc\n{"a":1}\n```')).toBeNull();
		expect(parseJSONObjectFromText('```python\n{"a":1}\n```')).toBeNull();
	});

	it("returns an array from a json5 fence and null from the object parser", () => {
		expect(extractAndParseJSONObjectFromText("```json5\n[1,2,]\n```")).toEqual([
			1, 2,
		]);
		expect(parseJSONObjectFromText("```json5\n[1,2,]\n```")).toBeNull();
	});
});
