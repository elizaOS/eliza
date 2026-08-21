/**
 * Verifies sanitizeReplyTextAfterMediaDelivery strips a delivered media URL (and
 * its echo) from the reply while leaving non-echo prose, code indentation, and
 * newlines untouched. Pure deterministic function test.
 */
import { describe, expect, it } from "vitest";
import { sanitizeReplyTextAfterMediaDelivery } from "../services/message.ts";

describe("sanitizeReplyTextAfterMediaDelivery", () => {
	it("scans a 100k-character failed URL candidate without backtracking", () => {
		const text = `http://${"http://".repeat(14_285)} tail`;
		expect(sanitizeReplyTextAfterMediaDelivery(text, [])).toBe(text);
		const manyCandidates = "http ".repeat(20_000);
		expect(sanitizeReplyTextAfterMediaDelivery(manyCandidates, [])).toBe(
			manyCandidates.trim(),
		);
	});
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

	it("returns a media-free reply completely untouched (newlines + indentation)", () => {
		const code =
			"result = []\n    for n in numbers:\n        if n >= 0:\n            result.append(n + 3)\n    return result";
		expect(sanitizeReplyTextAfterMediaDelivery(code, [])).toBe(code);

		const prose =
			"First paragraph.\n\nSecond paragraph:\n- item one\n- item two";
		expect(sanitizeReplyTextAfterMediaDelivery(prose, [])).toBe(prose);
	});

	it("keeps newlines away from the URL when stripping a delivered URL", () => {
		const sanitized = sanitizeReplyTextAfterMediaDelivery(
			`Your video is ready ${url}\nIt has:\n- scene one\n- scene two`,
			[url],
		);
		expect(sanitized).not.toContain(url);
		expect(sanitized).toContain("It has:\n- scene one\n- scene two");
	});
});
