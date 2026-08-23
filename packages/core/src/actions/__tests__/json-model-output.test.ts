import { describe, expect, it } from "vitest";
import {
	parseJsonModelArray,
	parseJsonModelOutput,
	parseJsonModelRecord,
} from "./json-model-output.ts";

describe("parseJsonModelOutput", () => {
	it("parses plain JSON", () => {
		expect(parseJsonModelOutput('{"a":1}')).toEqual({ a: 1 });
	});

	it("strips think preamble", () => {
		expect(parseJsonModelOutput('<think>reasoning</think>{"a":1}')).toEqual({
			a: 1,
		});
	});

	it("strips json code fences", () => {
		expect(parseJsonModelOutput('```json\n{"a":1}\n```')).toEqual({ a: 1 });
		expect(parseJsonModelOutput("```\n[1,2]\n```")).toEqual([1, 2]);
	});

	it("strips combined think + fence", () => {
		expect(
			parseJsonModelOutput('<think>x</think>```json5\n{"a":1}\n```'),
		).toEqual({ a: 1 });
	});

	it("returns null for malformed or empty input", () => {
		expect(parseJsonModelOutput("{not json")).toBeNull();
		expect(parseJsonModelOutput("")).toBeNull();
		expect(parseJsonModelOutput("<think>only</think>")).toBeNull();
	});
});

describe("parseJsonModelRecord", () => {
	it("returns records", () => {
		expect(parseJsonModelRecord('{"a":1}')).toEqual({ a: 1 });
	});

	it("rejects arrays and primitives", () => {
		expect(parseJsonModelRecord("[1,2]")).toBeNull();
		expect(parseJsonModelRecord('"str"')).toBeNull();
		expect(parseJsonModelRecord("5")).toBeNull();
	});
});

describe("parseJsonModelArray", () => {
	it("returns arrays", () => {
		expect(parseJsonModelArray("[1,2]")).toEqual([1, 2]);
	});

	it("rejects records", () => {
		expect(parseJsonModelArray('{"a":1}')).toBeNull();
	});
});
