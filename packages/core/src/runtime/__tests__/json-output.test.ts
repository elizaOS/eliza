import { describe, expect, it } from "vitest";

import { parseJsonObject } from "../json-output";

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

	it("repairs raw newlines, CRLF, CR, tabs, and invalid backslashes inside JSON strings", () => {
		const raw =
			String.raw`{"text":"line one` +
			"\n\n" +
			String.raw`line two` +
			"\r\n" +
			String.raw`line three` +
			"\r" +
			String.raw`cell` +
			"\t" +
			String.raw`value","path":"C:\Users\desk\zip"}`;
		expect(parseJsonObject(raw)).toEqual({
			text: "line one\n\nline two\r\nline three\rcell\tvalue",
			path: String.raw`C:\Users\desk\zip`,
		});
	});

	it("repairs control characters inside an extracted JSON object", () => {
		expect(parseJsonObject('prefix {"text":"a\nb","ok":true} suffix')).toEqual({
			text: "a\nb",
			ok: true,
		});
	});
});
