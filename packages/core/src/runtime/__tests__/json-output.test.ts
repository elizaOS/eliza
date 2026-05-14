import { describe, expect, it } from "vitest";

import { extractJsonObjects, parseJsonObject } from "../json-output";

describe("parseJsonObject", () => {
	it("parses the first balanced JSON object when providers append garbage", () => {
		expect(
			parseJsonObject('{"plan":{"contexts":["tasks"]},"thought":"ok"}\u0000'),
		).toEqual({
			plan: { contexts: ["tasks"] },
			thought: "ok",
		});
	});

	it("does not treat partial JSON as valid", () => {
		expect(parseJsonObject('{"plan":{"contexts":["tasks"]}')).toBeNull();
	});
});

describe("extractJsonObjects", () => {
	it("returns every top-level object from a concatenated stream", () => {
		expect(
			extractJsonObjects(
				'{"type":"REPLY"}\n{"type":"SPAWN","args":{"nested":{"x":1}}}',
			),
		).toEqual([
			'{"type":"REPLY"}',
			'{"type":"SPAWN","args":{"nested":{"x":1}}}',
		]);
	});

	it("ignores braces inside string values", () => {
		expect(extractJsonObjects('{"text":"a } b { c"}')).toEqual([
			'{"text":"a } b { c"}',
		]);
	});

	it("returns an empty array when there is no object", () => {
		expect(extractJsonObjects("just prose, no json here")).toEqual([]);
	});
});
