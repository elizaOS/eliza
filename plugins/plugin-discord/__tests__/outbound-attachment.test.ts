/**
 * buildOutboundDiscordAttachment — the byte-fetch + URL-fallback path (#9604).
 *
 * Generated VIDEO/AUDIO media at http(s) URLs is byte-fetched through the core
 * SSRF guard so Discord gets bytes without routing untrusted URLs through an
 * unguarded fetch. Private/internal fetch failures fail closed; public failures
 * can fall back to a URL attachment.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentType, type Media } from "@elizaos/core";
import { buildOutboundDiscordAttachment } from "../utils.ts";

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

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("buildOutboundDiscordAttachment", () => {
	it("byte-fetches VIDEO bytes into a Buffer-backed attachment on a 200", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(bytes, {
				status: 200,
				headers: { "content-type": "video/mp4" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const att = await buildOutboundDiscordAttachment(media({}));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(Buffer.isBuffer(att.attachment)).toBe(true);
		expect(Buffer.from(att.attachment as Buffer)).toEqual(Buffer.from(bytes));
	});

	it("fails closed for private/internal generated-media URLs when the fetch is not ok", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("bad", { status: 502 }));
		vi.stubGlobal("fetch", fetchMock);

		const url = "http://127.0.0.1:8080/v1/media/x/content";
		await expect(buildOutboundDiscordAttachment(media({ url }))).rejects.toThrow(
			"HTTP 502",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("fails closed for private/internal generated-media URLs when the fetch throws", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
		vi.stubGlobal("fetch", fetchMock);

		const url = "http://127.0.0.1:8080/v1/media/y/content";
		await expect(buildOutboundDiscordAttachment(media({ url }))).rejects.toThrow(
			"ECONNREFUSED",
		);
	});

	it("does not byte-fetch non-video/audio media (e.g. IMAGE)", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const url = "https://cdn.example.com/pic.png";
		const att = await buildOutboundDiscordAttachment(
			media({ url, contentType: ContentType.IMAGE }),
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(att.attachment).toBe(url);
	});

	it("does not byte-fetch non-generated video/audio URLs", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const url = "https://cdn.example.com/video.mp4";
		const att = await buildOutboundDiscordAttachment(
			media({ url, source: "user-upload" }),
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(att.attachment).toBe(url);
	});

	it("falls back to a URL attachment for public generated-media fetch failures", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("bad", { status: 502 }));
		vi.stubGlobal("fetch", fetchMock);

		const url = "https://cdn.example.com/video.mp4";
		const att = await buildOutboundDiscordAttachment(media({ url }));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(att.attachment).toBe(url);
	});
});
