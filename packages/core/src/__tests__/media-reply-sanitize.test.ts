import { describe, expect, it } from "vitest";
import { sanitizeReplyTextAfterMediaDelivery } from "../services/message.ts";

describe("sanitizeReplyTextAfterMediaDelivery", () => {
	const url = "http://192.168.255.164:8080/v1/videos/50a2f4c2/content";

	it("strips known media URLs and zerollama content paths", () => {
		expect(
			sanitizeReplyTextAfterMediaDelivery(`Here it is: <${url}>`, [url]),
		).toBe("");
		expect(
			sanitizeReplyTextAfterMediaDelivery(`Done. Video's up: ${url}`, [url]),
		).toBe("");
	});

	it("preserves meaningful text that is not a URL echo", () => {
		expect(
			sanitizeReplyTextAfterMediaDelivery(
				"Wan drifted from your prompt — want a tighter retry?",
				[url],
			),
		).toBe("Wan drifted from your prompt — want a tighter retry?");
	});
});
