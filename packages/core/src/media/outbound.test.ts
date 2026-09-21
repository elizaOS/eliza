/**
 * Unit tests for `resolveOutboundAttachmentBytes`. Data URLs are decoded
 * locally, filesystem paths are rejected without `fs` access, http(s) URLs
 * go through the real SSRF-guarded fetcher with injected DNS/transport, and
 * guard failures fail closed. Deterministic — no live network.
 */

import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaFetchError } from "./fetch.ts";
import {
	resolveOutboundAttachmentBytes,
	summarizeOutboundAttachmentUrl,
} from "./outbound.ts";

function transport(
	fetchMock: (input: string, init?: RequestInit) => Promise<Response>,
) {
	return {
		lookupFn: async () => [{ address: "203.0.113.7", family: 4 }],
		pinnedFetchImpl: async ({ url, init }: { url: URL; init?: RequestInit }) =>
			fetchMock(url.toString(), init),
		fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) =>
			fetchMock(String(input), init),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("summarizeOutboundAttachmentUrl", () => {
	it("omits the data-URL payload", () => {
		expect(
			summarizeOutboundAttachmentUrl("data:image/png;base64,aGVsbG8="),
		).toEqual({ scheme: "data", path: "image/png" });
	});

	it("omits the payload when the data scheme is uppercase", () => {
		expect(
			summarizeOutboundAttachmentUrl("DATA:image/png;base64,aGVsbG8="),
		).toEqual({ scheme: "data", path: "image/png" });
	});
});

describe("resolveOutboundAttachmentBytes", () => {
	it("decodes a data: image locally without fetching or touching fs", async () => {
		const fetchMock = vi.fn();
		const readSpy = vi.spyOn(fs, "readFileSync");
		const existsSpy = vi.spyOn(fs, "existsSync");
		const streamSpy = vi.spyOn(fs, "createReadStream");

		const out = await resolveOutboundAttachmentBytes(
			"data:image/png;base64,aGVsbG8=",
			transport(fetchMock),
		);

		expect(out.buffer.toString("utf8")).toBe("hello");
		expect(out.contentType).toBe("image/png");
		expect(out.fileName).toBe("attachment.png");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(readSpy).not.toHaveBeenCalled();
		expect(existsSpy).not.toHaveBeenCalled();
		expect(streamSpy).not.toHaveBeenCalled();
	});

	it("decodes an uppercase DATA: URL locally", async () => {
		const out = await resolveOutboundAttachmentBytes(
			"DATA:image/png;base64,aGVsbG8=",
		);
		expect(out.buffer.toString("utf8")).toBe("hello");
		expect(out.contentType).toBe("image/png");
	});

	it("rejects a local secrets path without reading it", async () => {
		const fetchMock = vi.fn();
		const readSpy = vi.spyOn(fs, "readFileSync");
		const existsSpy = vi.spyOn(fs, "existsSync");
		const streamSpy = vi.spyOn(fs, "createReadStream");

		await expect(
			resolveOutboundAttachmentBytes("/etc/passwd", transport(fetchMock)),
		).rejects.toBeInstanceOf(MediaFetchError);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(readSpy).not.toHaveBeenCalled();
		expect(existsSpy).not.toHaveBeenCalled();
		expect(streamSpy).not.toHaveBeenCalled();
	});

	it("rejects file: URLs without reading the host filesystem", async () => {
		const readSpy = vi.spyOn(fs, "readFileSync");
		await expect(
			resolveOutboundAttachmentBytes("file:///etc/passwd"),
		).rejects.toBeInstanceOf(MediaFetchError);
		expect(readSpy).not.toHaveBeenCalled();
	});

	it("fetches http(s) bytes through the SSRF guard", async () => {
		const bytes = Buffer.from("png-bytes");
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(bytes, {
				status: 200,
				headers: { "content-type": "image/png" },
			}),
		);

		const out = await resolveOutboundAttachmentBytes(
			"https://cdn.example.com/pic.png",
			transport(fetchMock),
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(out.buffer.equals(bytes)).toBe(true);
		expect(out.contentType).toBe("image/png");
	});

	it("fails closed when the guarded fetch is not ok", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("bad", { status: 502 }));

		await expect(
			resolveOutboundAttachmentBytes(
				"https://cdn.example.com/pic.png",
				transport(fetchMock),
			),
		).rejects.toMatchObject({ code: "http_error" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("fails closed for private/internal http(s) URLs without a public fallback", async () => {
		const fetchMock = vi.fn();
		await expect(
			resolveOutboundAttachmentBytes("http://127.0.0.1:8080/secret", {
				lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
				pinnedFetchImpl: async ({ url, init }) =>
					fetchMock(url.toString(), init),
				fetchImpl: async (input, init) => fetchMock(String(input), init),
			}),
		).rejects.toThrow(/private|internal|Blocked/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("loads canonical media-store handles through localFetch, not the remote guard", async () => {
		const sha = "a".repeat(64);
		const localFetch = vi.fn(
			async () =>
				new Response(Buffer.from("store-bytes"), {
					status: 200,
					headers: { "content-type": "image/png" },
				}),
		);
		const fetchMock = vi.fn();

		const out = await resolveOutboundAttachmentBytes(`/api/media/${sha}.png`, {
			localFetch,
			...transport(fetchMock),
		});

		expect(localFetch).toHaveBeenCalledTimes(1);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(out.buffer.toString("utf8")).toBe("store-bytes");
		expect(out.fileName).toBe(`${sha}.png`);
	});
});
