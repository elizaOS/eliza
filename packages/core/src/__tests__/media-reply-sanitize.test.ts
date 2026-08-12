/**
 * Verifies sanitizeReplyTextAfterMediaDelivery strips a delivered media URL (and
 * its echo) from the reply while leaving non-echo prose, code indentation, and
 * newlines untouched. Pure deterministic function test.
 */
import { describe, expect, it } from "vitest";
import { sanitizeReplyTextAfterMediaDelivery } from "../services/message.ts";

describe("sanitizeReplyTextAfterMediaDelivery", () => {
	const url = "http://192.168.255.164:8080/v1/videos/50a2f4c2/content";

	it("strips only exact case-sensitive delivered URL tokens", () => {
		expect(
			sanitizeReplyTextAfterMediaDelivery(`Here it is: <${url}>`, [url]),
		).toBe("");
		expect(
			sanitizeReplyTextAfterMediaDelivery(`Done. Video's up: ${url}`, [url]),
		).toBe("");

		const shortUrl = "https://example.test/media/abc";
		const longerUrl = `${shortUrl}def`;
		const caseVariant = "https://example.test/media/ABC";
		const regexMetacharUrl = "https://example.test/media/[clip](1)?token=a+b*$";
		const mixed = sanitizeReplyTextAfterMediaDelivery(
			`Keep ${longerUrl} and ${caseVariant}; remove <${shortUrl}> and ${regexMetacharUrl}`,
			[shortUrl, regexMetacharUrl],
		);
		expect(mixed).toContain(longerUrl);
		expect(mixed).toContain(caseVariant);
		expect(mixed).not.toContain(`<${shortUrl}>`);
		expect(mixed).not.toContain(regexMetacharUrl);
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

		const unreceiptedMediaUrl = `Here it is: ${url}`;
		expect(sanitizeReplyTextAfterMediaDelivery(unreceiptedMediaUrl, [])).toBe(
			unreceiptedMediaUrl,
		);
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
