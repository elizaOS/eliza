/**
 * buildOutboundDiscordAttachment — the byte-fetch + URL-fallback path (#9604).
 *
 * VIDEO/AUDIO media at http(s) URLs are byte-fetched so Discord (which cannot
 * reach the agent's LAN) gets the file; a non-ok response or a throw falls back
 * to a plain URL attachment, and non-video/audio media is never fetched.
 */

import { ContentType, type Media } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOutboundDiscordAttachment } from "../utils.ts";

function media(overrides: Partial<Media>): Media {
	return {
		id: "m1",
		url: "http://127.0.0.1:8080/v1/media/abc/content",
		title: "clip",
		contentType: ContentType.VIDEO,
		...overrides,
	} as Media;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("buildOutboundDiscordAttachment", () => {
	it("byte-fetches VIDEO bytes into a Buffer-backed attachment on a 200", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			arrayBuffer: async () => bytes.buffer,
		});
		vi.stubGlobal("fetch", fetchMock);

		const att = await buildOutboundDiscordAttachment(media({}));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(Buffer.isBuffer(att.attachment)).toBe(true);
		expect(Buffer.from(att.attachment as Buffer)).toEqual(Buffer.from(bytes));
	});

	it("falls back to a URL attachment when the fetch is not ok", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 502,
			arrayBuffer: async () => new ArrayBuffer(0),
		});
		vi.stubGlobal("fetch", fetchMock);

		const url = "http://127.0.0.1:8080/v1/media/x/content";
		const att = await buildOutboundDiscordAttachment(media({ url }));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(att.attachment).toBe(url);
	});

	it("falls back to a URL attachment when the fetch throws", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
		vi.stubGlobal("fetch", fetchMock);

		const url = "http://127.0.0.1:8080/v1/media/y/content";
		const att = await buildOutboundDiscordAttachment(media({ url }));
		expect(att.attachment).toBe(url);
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
});
