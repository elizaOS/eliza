/**
 * buildOutboundDiscordAttachment — resolve outbound bytes through the guarded
 * fetch / media store. `data:` URLs decode locally, filesystem paths are
 * rejected without `fs` access, http(s) URLs go through the real SSRF guard
 * (injected DNS + transport), and guard failures fail closed with no URL
 * fallback. Deterministic — no live Discord or network.
 */

import fs from "node:fs";
import { ContentType, type Media } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildOutboundDiscordAttachment,
	type OutboundAttachmentFetchOptions,
} from "../utils.ts";

function media(overrides: Partial<Media>): Media {
	return {
		id: "m1",
		url: "https://cdn.example.com/clip.mp4",
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

afterEach(() => {
	vi.restoreAllMocks();
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

		const att = await buildOutboundDiscordAttachment(
			media({}),
			undefined,
			transport(fetchMock),
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(Buffer.isBuffer(att.attachment)).toBe(true);
		expect(Buffer.from(att.attachment as Buffer)).toEqual(Buffer.from(bytes));
	});

	it("byte-fetches IMAGE bytes instead of passing the raw URL to discord.js", async () => {
		const bytes = new Uint8Array([9, 8, 7]);
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(bytes, {
				status: 200,
				headers: { "content-type": "image/png" },
			}),
		);

		const url = "https://cdn.example.com/pic.png";
		const att = await buildOutboundDiscordAttachment(
			media({ url, contentType: ContentType.IMAGE }),
			undefined,
			transport(fetchMock),
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(Buffer.isBuffer(att.attachment)).toBe(true);
		expect(Buffer.from(att.attachment as Buffer)).toEqual(Buffer.from(bytes));
		expect(typeof att.attachment === "string").toBe(false);
	});

	it("decodes a data: image locally and never treats it as a filesystem path", async () => {
		const fetchMock = vi.fn();
		const readSpy = vi.spyOn(fs, "readFileSync");
		const existsSpy = vi.spyOn(fs, "existsSync");
		const streamSpy = vi.spyOn(fs, "createReadStream");

		const att = await buildOutboundDiscordAttachment(
			media({
				url: "data:image/png;base64,aGVsbG8=",
				contentType: ContentType.IMAGE,
				title: "cat.png",
			}),
			undefined,
			transport(fetchMock),
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(readSpy).not.toHaveBeenCalled();
		expect(existsSpy).not.toHaveBeenCalled();
		expect(streamSpy).not.toHaveBeenCalled();
		expect(Buffer.isBuffer(att.attachment)).toBe(true);
		expect(Buffer.from(att.attachment as Buffer).toString("utf8")).toBe(
			"hello",
		);
		expect(att.name).toBe("cat.png");
	});

	it("rejects a local secrets path without reading it", async () => {
		const fetchMock = vi.fn();
		const readSpy = vi.spyOn(fs, "readFileSync");
		const existsSpy = vi.spyOn(fs, "existsSync");
		const streamSpy = vi.spyOn(fs, "createReadStream");

		await expect(
			buildOutboundDiscordAttachment(
				media({ url: "/etc/passwd", contentType: ContentType.DOCUMENT }),
				undefined,
				transport(fetchMock),
			),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(readSpy).not.toHaveBeenCalled();
		expect(existsSpy).not.toHaveBeenCalled();
		expect(streamSpy).not.toHaveBeenCalled();
	});

	it("fails closed for private/internal URLs when the fetch is not ok", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("bad", { status: 502 }));

		const url = "http://127.0.0.1:8080/v1/media/x/content";
		await expect(
			buildOutboundDiscordAttachment(media({ url }), undefined, {
				lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
				pinnedFetchImpl: async ({ url: fetched, init }) =>
					fetchMock(fetched.toString(), init),
				fetchImpl: async (input, init) => fetchMock(String(input), init),
			}),
		).rejects.toThrow(/private|internal|Blocked/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fails closed for private/internal URLs when the lookup is blocked", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("must not fetch"));

		const url = "http://127.0.0.1:8080/v1/media/y/content";
		await expect(
			buildOutboundDiscordAttachment(media({ url }), undefined, {
				lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
				pinnedFetchImpl: async ({ url: fetched, init }) =>
					fetchMock(fetched.toString(), init),
				fetchImpl: async (input, init) => fetchMock(String(input), init),
			}),
		).rejects.toThrow(/private|internal|Blocked/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("byte-fetches non-generated video/audio URLs through the guard", async () => {
		const bytes = new Uint8Array([5, 6]);
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(bytes, {
				status: 200,
				headers: { "content-type": "video/mp4" },
			}),
		);

		const url = "https://cdn.example.com/video.mp4";
		const att = await buildOutboundDiscordAttachment(
			media({ url, source: "user-upload" }),
			undefined,
			transport(fetchMock),
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(Buffer.isBuffer(att.attachment)).toBe(true);
	});

	it("fails closed for public fetch failures instead of falling back to a URL attachment", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("bad", { status: 502 }));

		const url = "https://cdn.example.com/video.mp4";
		await expect(
			buildOutboundDiscordAttachment(
				media({ url }),
				undefined,
				transport(fetchMock),
			),
		).rejects.toThrow(/HTTP 502/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
