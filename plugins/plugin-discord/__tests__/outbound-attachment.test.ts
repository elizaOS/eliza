/**
 * buildOutboundDiscordAttachment — the byte-fetch + URL-fallback path (#9604).
 *
 * Generated VIDEO/AUDIO media at http(s) URLs is byte-fetched through the core
 * SSRF guard so Discord gets bytes without routing untrusted URLs through an
 * unguarded fetch. Private/internal fetch failures fail closed; public failures
 * can fall back to a URL attachment.
 */

import { ContentType, type Media } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOutboundDiscordAttachment } from "../utils.ts";

const fetchRemoteMediaMock = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/core", async (importActual) => {
	const actual = await importActual<typeof import("@elizaos/core")>();
	return {
		...actual,
		fetchRemoteMedia: fetchRemoteMediaMock,
	};
});

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
	fetchRemoteMediaMock.mockReset();
});

describe("buildOutboundDiscordAttachment", () => {
	it("byte-fetches VIDEO bytes into a Buffer-backed attachment on a 200", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		fetchRemoteMediaMock.mockResolvedValue({
			buffer: Buffer.from(bytes),
			contentType: "video/mp4",
		});

		const att = await buildOutboundDiscordAttachment(media({}));
		expect(fetchRemoteMediaMock).toHaveBeenCalledTimes(1);
		expect(fetchRemoteMediaMock).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "http://127.0.0.1:8080/v1/media/abc/content",
			}),
		);
		expect(Buffer.isBuffer(att.attachment)).toBe(true);
		expect(Buffer.from(att.attachment as Buffer)).toEqual(Buffer.from(bytes));
	});

	it("fails closed for private/internal generated-media URLs when the fetch is not ok", async () => {
		fetchRemoteMediaMock.mockRejectedValue(new Error("HTTP 502"));

		const url = "http://127.0.0.1:8080/v1/media/x/content";
		await expect(
			buildOutboundDiscordAttachment(media({ url })),
		).rejects.toThrow("HTTP 502");
		expect(fetchRemoteMediaMock).toHaveBeenCalledTimes(1);
		expect(fetchRemoteMediaMock).toHaveBeenCalledWith(
			expect.objectContaining({ url }),
		);
	});

	it("fails closed for private/internal generated-media URLs when the fetch throws", async () => {
		fetchRemoteMediaMock.mockRejectedValue(new Error("ECONNREFUSED"));

		const url = "http://127.0.0.1:8080/v1/media/y/content";
		await expect(
			buildOutboundDiscordAttachment(media({ url })),
		).rejects.toThrow("ECONNREFUSED");
	});

	it("does not byte-fetch non-video/audio media (e.g. IMAGE)", async () => {
		const url = "https://cdn.example.com/pic.png";
		const att = await buildOutboundDiscordAttachment(
			media({ url, contentType: ContentType.IMAGE }),
		);
		expect(fetchRemoteMediaMock).not.toHaveBeenCalled();
		expect(att.attachment).toBe(url);
	});

	it("does not byte-fetch non-generated video/audio URLs", async () => {
		const url = "https://cdn.example.com/video.mp4";
		const att = await buildOutboundDiscordAttachment(
			media({ url, source: "user-upload" }),
		);
		expect(fetchRemoteMediaMock).not.toHaveBeenCalled();
		expect(att.attachment).toBe(url);
	});

	it("falls back to a URL attachment for public generated-media fetch failures", async () => {
		fetchRemoteMediaMock.mockRejectedValue(new Error("HTTP 502"));

		const url = "https://cdn.example.com/video.mp4";
		const att = await buildOutboundDiscordAttachment(media({ url }));
		expect(fetchRemoteMediaMock).toHaveBeenCalledTimes(1);
		expect(fetchRemoteMediaMock).toHaveBeenCalledWith(
			expect.objectContaining({ url }),
		);
		expect(att.attachment).toBe(url);
	});
});
