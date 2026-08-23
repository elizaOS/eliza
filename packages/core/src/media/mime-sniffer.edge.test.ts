/**
 * Unit tests for edge magic-byte MIME type sniffer.
 */

import { describe, expect, it } from "vitest";
import { sniffMime } from "./mime-sniffer.edge.js";

describe("mime-sniffer.edge", () => {
	it("returns undefined for undefined or empty buffer", async () => {
		expect(await sniffMime(undefined)).toBeUndefined();
		expect(await sniffMime(new Uint8Array([]))).toBeUndefined();
	});

	it("identifies image formats: png, jpeg, gif, webp", async () => {
		const png = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		expect(await sniffMime(png)).toBe("image/png");

		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
		expect(await sniffMime(jpeg)).toBe("image/jpeg");

		const gif87 = new TextEncoder().encode("GIF87a-some-data");
		expect(await sniffMime(gif87)).toBe("image/gif");

		const gif89 = new TextEncoder().encode("GIF89a-some-data");
		expect(await sniffMime(gif89)).toBe("image/gif");

		const webp = new Uint8Array([
			...new TextEncoder().encode("RIFF"),
			0,
			0,
			0,
			0,
			...new TextEncoder().encode("WEBP"),
		]);
		expect(await sniffMime(webp)).toBe("image/webp");
	});

	it("identifies document and archive formats: pdf, zip, gzip", async () => {
		const pdf = new TextEncoder().encode("%PDF-1.4");
		expect(await sniffMime(pdf)).toBe("application/pdf");

		const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
		expect(await sniffMime(zip)).toBe("application/zip");

		const gzip = new Uint8Array([0x1f, 0x8b, 0x08]);
		expect(await sniffMime(gzip)).toBe("application/gzip");
	});

	it("identifies audio and video formats: ogg, mp3, wav, mp4", async () => {
		const ogg = new TextEncoder().encode("OggS-stream");
		expect(await sniffMime(ogg)).toBe("audio/ogg");

		const id3 = new TextEncoder().encode("ID3-mp3-data");
		expect(await sniffMime(id3)).toBe("audio/mpeg");

		const wav = new Uint8Array([
			...new TextEncoder().encode("RIFF"),
			0,
			0,
			0,
			0,
			...new TextEncoder().encode("WAVE"),
		]);
		expect(await sniffMime(wav)).toBe("audio/wav");

		const mp4 = new Uint8Array([
			0,
			0,
			0,
			20,
			...new TextEncoder().encode("ftypisom"),
		]);
		expect(await sniffMime(mp4)).toBe("video/mp4");
	});
});
