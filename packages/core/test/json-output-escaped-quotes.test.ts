import { describe, expect, it } from "vitest";
import { parseMessageHandlerOutput } from "../../../plugins/plugin-assistant/src/runtime/message-handler.ts";
import { parseJsonObject } from "../src/runtime/json-output";

describe("parseJsonObject escaped quotes with raw newlines", () => {
	it("keeps a valid escaped quote before a comma when repairing a raw newline", () => {
		const raw =
			'{"shouldRespond":"RESPOND","contexts":["simple"],"replyText":"The word \\"ok\\", spelled\nout."}';

		expect(parseJsonObject(raw)).toEqual({
			shouldRespond: "RESPOND",
			contexts: ["simple"],
			replyText: 'The word "ok", spelled\nout.',
		});
		expect(parseMessageHandlerOutput(raw)?.plan.reply).toBe(
			'The word "ok", spelled\nout.',
		);
	});

	it("still reads a trailing backslash before a closing quote", () => {
		expect(parseJsonObject('{"path":"C:\\","next":"x\ny"}')).toEqual({
			path: "C:\\",
			next: "x\ny",
		});
	});
});
