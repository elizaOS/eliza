/**
 * Unit tests for the connector attachment helpers — `contentTypeForMime`,
 * `toMedia`, and `resolveAttachmentBytes` — with the SSRF-guarded media fetcher
 * mocked so the suite makes no real network request.
 */
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

// Network-free: the SSRF-guarded fetcher is mocked so no real request is made.
const fetchRemoteMedia = vi.fn();
vi.mock("../media/fetch", async (importActual) => ({
	...(await importActual<typeof import("../media/fetch")>()),
	fetchRemoteMedia: (...args: unknown[]) => fetchRemoteMedia(...args),
}));

const {
	contentTypeForMime,
	toMedia,
	resolveAttachmentBytes,
	DEFAULT_CONNECTOR_ATTACHMENT_MAX_BYTES,
} = await import("./attachments");

describe("contentTypeForMime", () => {
	it("maps mime prefixes to the coarse ContentType", () => {
		expect(contentTypeForMime("image/png")).toBe("image");
		expect(contentTypeForMime("video/mp4")).toBe("video");
		expect(contentTypeForMime("audio/ogg; codecs=opus")).toBe("audio");
		expect(contentTypeForMime("application/pdf")).toBe("document");
	});

	it("defaults unknown/absent types to document", () => {
		expect(contentTypeForMime(undefined)).toBe("document");
		expect(contentTypeForMime(null)).toBe("document");
		expect(contentTypeForMime("")).toBe("document");
		expect(contentTypeForMime("application/octet-stream")).toBe("document");
	});
});

describe("toMedia", () => {
	it("normalizes a raw attachment with derived contentType + metadata", () => {
		const m = toMedia({
			id: 7,
			url: "https://x/y.png",
			mimeType: "image/png; charset=binary",
			fileName: "y.png",
			size: 123,
			title: "pic",
		});
		expect(m).toMatchObject({
			id: "7",
			url: "https://x/y.png",
			contentType: "image",
			filename: "y.png",
			size: 123,
			title: "pic",
			mimeType: "image/png",
		});
	});

	it("falls back to the url for id and omits absent fields", () => {
		const m = toMedia({ url: "https://x/doc" });
		expect(m.id).toBe("https://x/doc");
		expect(m.contentType).toBe("document");
		expect(m.size).toBeUndefined();
		expect(m.mimeType).toBeUndefined();
		expect(m.filename).toBeUndefined();
	});

	it("uses idFallback when no id is supplied", () => {
		expect(toMedia({ url: "u" }, { idFallback: "fb" }).id).toBe("fb");
	});
});

describe("resolveAttachmentBytes", () => {
	it("fetches via the SSRF-guarded fetcher with the default cap", async () => {
		fetchRemoteMedia.mockResolvedValue({
			buffer: Buffer.from("hi"),
			contentType: "image/png",
			fileName: "a.png",
		});
		const out = await resolveAttachmentBytes("https://x/a.png");
		expect(fetchRemoteMedia).toHaveBeenCalledWith({
			url: "https://x/a.png",
			maxBytes: DEFAULT_CONNECTOR_ATTACHMENT_MAX_BYTES,
		});
		expect(out.contentType).toBe("image/png");
		expect(out.fileName).toBe("a.png");
		expect(out.buffer.toString()).toBe("hi");
	});

	it("defaults contentType when omitted and honors a custom maxBytes", async () => {
		fetchRemoteMedia.mockResolvedValue({ buffer: Buffer.from("x") });
		const out = await resolveAttachmentBytes("https://x/a", { maxBytes: 10 });
		expect(fetchRemoteMedia).toHaveBeenCalledWith({
			url: "https://x/a",
			maxBytes: 10,
		});
		expect(out.contentType).toBe("application/octet-stream");
		expect(out.fileName).toBeUndefined();
	});

	it("propagates SSRF/fetch failures", async () => {
		fetchRemoteMedia.mockRejectedValue(new Error("blocked"));
		await expect(
			resolveAttachmentBytes("http://169.254.169.254/x"),
		).rejects.toThrow("blocked");
	});
});
