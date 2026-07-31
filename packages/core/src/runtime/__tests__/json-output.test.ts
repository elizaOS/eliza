/**
 * Covers the model-output JSON salvage helpers — parseJsonObject,
 * extractJsonObjects, and repairJsonStringEscapes — over trailing garbage, raw
 * control chars, invalid backslash escapes, and prose-embedded objects. Pure
 * functions, no runtime.
 */
import { describe, expect, it } from "vitest";

import {
	extractJsonObjects,
	parseJsonObject,
	repairJsonStringEscapes,
	stripJsonStructuralJunkReply,
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

describe("stripJsonStructuralJunkReply — leaked pseudo-tool markup", () => {
	it("strips a paired invented pseudo-tool tag block (cerebras <BROWSE_PAGE>)", () => {
		expect(
			stripJsonStructuralJunkReply(
				"checking the repo directly.\n\n<BROWSE_PAGE><url>https://github.com/x</url></BROWSE_PAGE>",
			),
		).toBe("checking the repo directly.");
	});

	it("strips a truncated-open pseudo-tool tag to end of string", () => {
		expect(
			stripJsonStructuralJunkReply("here it is <WEB_FETCH> and then nothing"),
		).toBe("here it is");
	});

	it("strips the native <tool_call> serialization", () => {
		expect(
			stripJsonStructuralJunkReply(
				"<tool_call>WEB_FETCH<arg_key>url</arg_key></tool_call>",
			),
		).toBe("");
	});

	it("preserves ordinary prose and lowercase html mentions", () => {
		expect(stripJsonStructuralJunkReply("use the <div> tag in html")).toBe(
			"use the <div> tag in html",
		);
		expect(stripJsonStructuralJunkReply("the answer is 42")).toBe(
			"the answer is 42",
		);
	});

	it("does not touch short quoted acronyms", () => {
		expect(
			stripJsonStructuralJunkReply("the <AI> label means artificial"),
		).toBe("the <AI> label means artificial");
	});

	it("preserves plain uppercase technical tags regardless of length", () => {
		expect(
			stripJsonStructuralJunkReply(
				"Use <HTML><BODY>content</BODY></HTML> and return <JSON> or <UUID> values over <HTTP>.",
			),
		).toBe(
			"Use <HTML><BODY>content</BODY></HTML> and return <JSON> or <UUID> values over <HTTP>.",
		);
		expect(
			stripJsonStructuralJunkReply(
				"A truncated example such as <HTTP> GET /health remains prose",
			),
		).toBe("A truncated example such as <HTTP> GET /health remains prose");
	});
});
