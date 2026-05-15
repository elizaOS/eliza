import { describe, expect, it } from "vitest";

import {
	extractJsonObjects,
	parseJsonObject,
	repairJsonStringEscapes,
} from "../json-output";

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

	it("repairs raw LF, CRLF, CR, and tabs inside JSON string fields", () => {
		expect(
			parseJsonObject(
				'{"replyText":"one\ntwo\r\nthree\rfour\tfive","contexts":["simple"]}',
			),
		).toEqual({
			replyText: "one\ntwo\r\nthree\rfour\tfive",
			contexts: ["simple"],
		});
	});

	it("repairs invalid backslash escapes without touching valid JSON escapes", () => {
		expect(
			parseJsonObject(
				String.raw`{"replyText":"bad \q path C:\Users\Name\Desktop and valid \n \u263a","contexts":["simple"]}`,
			),
		).toEqual({
			replyText: "bad \\q path C:\\Users\\Name\\Desktop and valid \n ☺",
			contexts: ["simple"],
		});
	});

	it("repairs a critical string field that ends with a backslash before the next key", () => {
		expect(
			parseJsonObject(
				String.raw`{"replyText":"path C:\Users\Name\","contexts":["simple"]}`,
			),
		).toEqual({
			replyText: "path C:\\Users\\Name\\",
			contexts: ["simple"],
		});
	});

	it("preserves valid escaped quotes because valid JSON parses before repair", () => {
		expect(
			parseJsonObject(
				'{"replyText":"She said \\"hello\\" before continuing.","contexts":["simple"]}',
			),
		).toEqual({
			replyText: 'She said "hello" before continuing.',
			contexts: ["simple"],
		});
	});

	it("repairs extracted objects embedded in prose", () => {
		expect(
			parseJsonObject(
				'prefix {"replyText":"first line\nsecond line","contexts":["simple"]} suffix',
			),
		).toEqual({
			replyText: "first line\nsecond line",
			contexts: ["simple"],
		});
	});

	it("does not rewrite escapes outside quoted strings", () => {
		expect(repairJsonStringEscapes('{"ok":true}\\n')).toBe('{"ok":true}\\n');
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
