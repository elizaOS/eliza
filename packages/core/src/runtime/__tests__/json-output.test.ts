/**
 * Covers the model-output JSON salvage helpers — parseJsonObject,
 * extractJsonObjects, and repairJsonStringEscapes — over trailing garbage, raw
 * control chars, invalid backslash escapes, and prose-embedded objects. Pure
 * functions, no runtime.
 */
import { describe, expect, it } from "vitest";

import {
	containsToolCallShapedMarkup,
	extractJsonObjects,
	parseJsonObject,
	parsePseudoTagToolInvocations,
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

	it("strips adjacent leading tool protocol objects from Cerebras final prose", () => {
		expect(
			stripJsonStructuralJunkReply(
				'{"action":"get-notes","view":"notes"}text: {"effect":"get-notes","status":"success","notes":[{"id":"note1","content":"test"}],"revision":1}Notes opened. You have one note: “test”.',
			),
		).toBe("Notes opened. You have one note: “test”.");
	});

	it("preserves an ordinary leading JSON answer", () => {
		expect(stripJsonStructuralJunkReply('{"answer":42} is the payload')).toBe(
			'{"answer":42} is the payload',
		);
	});
});

describe("parsePseudoTagToolInvocations — F38 strip-and-send recovery (tj-9129a432454364)", () => {
	it("recovers the live stage-7 invocation with its JSON args", () => {
		const calls = parsePseudoTagToolInvocations(
			'temp is 35°C. saving note.\n\n<NOTES_CREATE>\n{"title": "b50 paris wx", "content": "Paris temperature: 35°C"}\n</NOTES_CREATE>',
		);
		expect(calls).toEqual([
			{
				name: "NOTES_CREATE",
				params: { title: "b50 paris wx", content: "Paris temperature: 35°C" },
			},
		]);
	});

	it("recovers multiple invocations in one reply", () => {
		const calls = parsePseudoTagToolInvocations(
			'<NOTES_CREATE>{"title":"a"}</NOTES_CREATE> then <TODOS_CREATE>{"title":"b"}</TODOS_CREATE>',
		);
		expect(calls.map((c) => c.name)).toEqual(["NOTES_CREATE", "TODOS_CREATE"]);
	});

	it("does not fabricate a call from a non-JSON body", () => {
		expect(
			parsePseudoTagToolInvocations(
				"<BROWSE_PAGE>the eliza repo</BROWSE_PAGE>",
			),
		).toEqual([]);
	});

	it("does not fabricate a call from an underscore-less tag or a JSON array body", () => {
		expect(parsePseudoTagToolInvocations('<HTML>{"a":1}</HTML>')).toEqual([]);
		expect(
			parsePseudoTagToolInvocations("<NOTES_CREATE>[1,2]</NOTES_CREATE>"),
		).toEqual([]);
	});
});

describe("containsToolCallShapedMarkup", () => {
	it("detects native markup, pseudo-tags, and truncated-open forms", () => {
		expect(
			containsToolCallShapedMarkup(
				"<tool_call>WEB_FETCH<arg_key>url</arg_key>",
			),
		).toBe(true);
		expect(
			containsToolCallShapedMarkup(
				'saving note. <NOTES_CREATE>{"t":1}</NOTES_CREATE>',
			),
		).toBe(true);
		expect(containsToolCallShapedMarkup("<BROWSE_PAGE><url>x</url>")).toBe(
			true,
		);
	});

	it("leaves ordinary prose and short quoted acronyms alone", () => {
		expect(
			containsToolCallShapedMarkup("the <AI> label means artificial"),
		).toBe(false);
		expect(containsToolCallShapedMarkup("plain answer, 35°C in paris")).toBe(
			false,
		);
	});
});
