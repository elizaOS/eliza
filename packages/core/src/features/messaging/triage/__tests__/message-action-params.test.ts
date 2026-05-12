import { describe, expect, it } from "vitest";

import {
	parseDraftReplyParams,
	parseRespondToMessageParams,
} from "../actions/_shared.ts";

describe("message reply action parameter parsing", () => {
	it("accepts common reply body aliases", () => {
		const parsed = parseDraftReplyParams({
			parameters: { messageId: "msg-1", replyText: "Sounds good, thanks." },
		} as never);

		expect(parsed).toEqual({
			messageId: "msg-1",
			body: "Sounds good, thanks.",
			lookup: {},
		});
	});

	it("rejects placeholder draft reply bodies", () => {
		const parsed = parseDraftReplyParams({
			parameters: {
				messageId: "msg-1",
				reply: "[Please provide the reply content you would like to send.]",
			},
		} as never);

		expect(parsed).toEqual({ error: "body is required" });
	});

	it("allows MESSAGE to synthesize a conservative body later", () => {
		const parsed = parseRespondToMessageParams({
			parameters: {
				messageId: "msg-1",
				reply: "[Please provide the reply content you would like to send.]",
			},
		} as never);

		expect(parsed).toEqual({
			messageId: "msg-1",
			body: undefined,
			lookup: {},
		});
	});
});
