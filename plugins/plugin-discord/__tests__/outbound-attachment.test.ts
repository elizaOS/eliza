/**
 * buildOutboundDiscordAttachment — the byte-fetch + URL-fallback path (#9604).
 *
 * Generated VIDEO/AUDIO media at http(s) URLs is byte-fetched through the core
 * SSRF guard so Discord gets bytes without routing untrusted URLs through an
 * unguarded fetch. Private/internal fetch failures fail closed; public failures
 * can fall back to a URL attachment. The REAL guard runs in every case — only
 * DNS + transport are injected (lookupFn + pinned/plain fetch impls), since the
 * guard's node pinned transport bypasses a stubbed global fetch by design.
 */

import { ContentType, type Media } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	buildOutboundDiscordAttachment,
	type OutboundAttachmentFetchOptions,
} from "../utils.ts";

function media(overrides: Partial<Media>): Media {
	return {
		id: "m1",
		url: "http://127.0.0.1:8080/v1/media/abc/content",
		title: "clip",
		contentType: ContentType.VIDEO,
		source: "media-generation",
		...overrides,
	} as Media;
}

/** Route BOTH guard transports (pinned and plain) into one countable mock, and
 *  resolve names deterministically — whichever branch the guard picks, the
 *  test observes exactly one wire attempt. */
function transport(
	fetchMock: ReturnType<typeof vi.fn>,
): OutboundAttachmentFetchOptions {
	return {
		lookupFn: async () => [{ address: "203.0.113.7", family: 4 }],
		pinnedFetchImpl: async ({ url, init }) => fetchMock(url.toString(), init),
		fetchImpl: async (input, init) => fetchMock(String(input), init),
	};
}

describe("buildOutboundDiscordAttachment", () => {
	it("byte-fetches VIDEO bytes into a Buffer-backed attachment on a 200", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(bytes, {
				status: 200,
				headers: { "content-type": "video/mp4" },
			}),
		);

		const att = await buildOutboundDiscordAttachment(
			media({}),
			undefined,
			transport(fetchMock),
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(Buffer.isBuffer(att.attachment)).toBe(true);
		expect(Buffer.from(att.attachment as Buffer)).toEqual(Buffer.from(bytes));
	});

	it("fails closed for private/internal generated-media URLs when the fetch is not ok", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("bad", { status: 502 }));

		const url = "http://127.0.0.1:8080/v1/media/x/content";
		await expect(
			buildOutboundDiscordAttachment(
				media({ url }),
				undefined,
				transport(fetchMock),
			),
		).rejects.toThrow("HTTP 502");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("fails closed for private/internal generated-media URLs when the fetch throws", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

		const url = "http://127.0.0.1:8080/v1/media/y/content";
		await expect(
			buildOutboundDiscordAttachment(
				media({ url }),
				undefined,
				transport(fetchMock),
			),
		).rejects.toThrow("ECONNREFUSED");
	});

	it("does not byte-fetch non-video/audio media (e.g. IMAGE)", async () => {
		const fetchMock = vi.fn();

		const url = "https://cdn.example.com/pic.png";
		const att = await buildOutboundDiscordAttachment(
			media({ url, contentType: ContentType.IMAGE }),
			undefined,
			transport(fetchMock),
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(att.attachment).toBe(url);
	});

	it("does not byte-fetch non-generated video/audio URLs", async () => {
		const fetchMock = vi.fn();

		const url = "https://cdn.example.com/video.mp4";
		const att = await buildOutboundDiscordAttachment(
			media({ url, source: "user-upload" }),
			undefined,
			transport(fetchMock),
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(att.attachment).toBe(url);
	});

	it("falls back to a URL attachment for public generated-media fetch failures", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("bad", { status: 502 }));

		const url = "https://cdn.example.com/video.mp4";
		const att = await buildOutboundDiscordAttachment(
			media({ url }),
			undefined,
			transport(fetchMock),
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(att.attachment).toBe(url);
	});
});
