/**
 * Verifies sanitizeReplyTextAfterMediaDelivery strips a delivered media URL (and
 * its echo) from the reply while leaving non-echo prose, code indentation, and
 * newlines untouched. Pure deterministic function test.
 */
import { describe, expect, it } from "vitest";
import { collectMediaDeliveryUrls } from "../services/message/media-delivery";
import { sanitizeReplyTextAfterMediaDelivery } from "../services/message.ts";

describe("media result classification", () => {
	it("preserves a fetched source URL and the complete surrounding reply", () => {
		const source =
			"https://api.example.test/price?ids=bitcoin&vs_currencies=usd";
		const reply = `Price: 75661 USD.\n\nSource: ${source}\nTimestamp: 1789566220`;
		const urls = collectMediaDeliveryUrls([
			{
				success: true,
				data: { actionName: "WEB_FETCH", url: source, kind: "json" },
			},
		]);
		expect(urls).toEqual([]);
		expect(sanitizeReplyTextAfterMediaDelivery(reply, urls)).toBe(reply);
	});

	it("does not infer media delivery from an arbitrary action's URL", () => {
		const url = "https://example.test/issues/123";
		expect(
			collectMediaDeliveryUrls([{ success: true, data: { url } }]),
		).toEqual([]);
	});

	it("keeps explicit media references distinct from a source URL", () => {
		const image = "https://example.test/image.png";
		const source = "https://example.test/source";
		const urls = collectMediaDeliveryUrls([
			{
				success: true,
				data: { mediaUrl: image, imageUrl: image, url: source },
			},
			{ success: false, data: { videoUrl: "https://example.test/failed.mp4" } },
		]);
		expect(urls).toEqual([image]);
		expect(
			sanitizeReplyTextAfterMediaDelivery(
				`Image: ${image}\nSource: ${source}`,
				urls,
			),
		).toContain(source);
	});
});

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

	it("strips embedded endpoints wrapped in punctuation or carrying a query", () => {
		expect(sanitizeReplyTextAfterMediaDelivery(`Saved (${url}).`, [])).toBe(
			"Saved .",
		);
		expect(
			sanitizeReplyTextAfterMediaDelivery(`Download: ${url}?download=1`, []),
		).toBe("Download:?download=1");
	});

	it("finds the endpoint after an earlier /v1/ segment", () => {
		const nested =
			"http://192.168.255.164:8080/v1/proxy/v1/videos/50a2f4c2/content";
		expect(
			sanitizeReplyTextAfterMediaDelivery(`Here you go ${nested}`, []),
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
