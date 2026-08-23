/**
 * Tests for the Workerd/edge magic-byte MIME sniffer.
 */
import { describe, expect, it } from "vitest";
import { sniffMime } from "./mime-sniffer.edge.ts";

const u8 = (values: number[]): Uint8Array => new Uint8Array(values);

const ascii = (text: string): Uint8Array =>
	u8([...text].map((c) => c.charCodeAt(0)));

describe("edge sniffMime magic-byte detection", () => {
	it("returns undefined for an empty buffer", async () => {
		await expect(sniffMime(new Uint8Array(0))).resolves.toBeUndefined();
	});

	it("returns undefined when no buffer is passed", async () => {
		await expect(sniffMime()).resolves.toBeUndefined();
	});

	it("detects PNG from its 8-byte signature", async () => {
		await expect(
			sniffMime(u8([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])),
		).resolves.toBe("image/png");
	});

	it("detects JPEG from its 3-byte signature", async () => {
		await expect(sniffMime(u8([0xff, 0xd8, 0xff, 0xe0]))).resolves.toBe(
			"image/jpeg",
		);
	});

	it("detects GIF87a and GIF89a", async () => {
		await expect(sniffMime(ascii("GIF87a..."))).resolves.toBe("image/gif");
		await expect(sniffMime(ascii("GIF89a..."))).resolves.toBe("image/gif");
	});

	it("detects WebP inside a RIFF container", async () => {
		const riff = u8([
			0x52,
			0x49,
			0x46,
			0x46, // RIFF
			0x00,
			0x00,
			0x00,
			0x00, // size
			0x57,
			0x45,
			0x42,
			0x50, // WEBP
		]);
		await expect(sniffMime(riff)).resolves.toBe("image/webp");
	});

	it("detects PDF from its %PDF- header", async () => {
		await expect(sniffMime(ascii("%PDF-1.7"))).resolves.toBe("application/pdf");
	});

	it("detects ZIP and gzip from their signatures", async () => {
		await expect(sniffMime(u8([0x50, 0x4b, 0x03, 0x04]))).resolves.toBe(
			"application/zip",
		);
		await expect(sniffMime(u8([0x1f, 0x8b, 0x08]))).resolves.toBe(
			"application/gzip",
		);
	});

	it("detects Ogg and ID3-tagged MP3 audio", async () => {
		await expect(sniffMime(ascii("OggS\x00\x02"))).resolves.toBe("audio/ogg");
		await expect(sniffMime(ascii("ID3\x04\x00"))).resolves.toBe("audio/mpeg");
	});

	it("detects WAV inside a RIFF container", async () => {
		const riff = u8([
			0x52,
			0x49,
			0x46,
			0x46, // RIFF
			0x00,
			0x00,
			0x00,
			0x00, // size
			0x57,
			0x41,
			0x56,
			0x45, // WAVE
		]);
		await expect(sniffMime(riff)).resolves.toBe("audio/wav");
	});

	it("detects MP4 from the ftyp box at offset 4", async () => {
		await expect(
			sniffMime(u8([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69])),
		).resolves.toBe("video/mp4");
	});

	it("returns undefined for unknown bytes", async () => {
		await expect(sniffMime(ascii("hello world"))).resolves.toBeUndefined();
	});

	it("does not treat a RIFF container with an unknown tag as webp/wav", async () => {
		const riff = u8([
			0x52,
			0x49,
			0x46,
			0x46, // RIFF
			0x00,
			0x00,
			0x00,
			0x00, // size
			0x4c,
			0x49,
			0x53,
			0x54, // LIST — not WEBP/WAVE
		]);
		await expect(sniffMime(riff)).resolves.toBeUndefined();
	});

	it("ignores a partial signature (too few bytes)", async () => {
		await expect(sniffMime(u8([0x89, 0x50]))).resolves.toBeUndefined();
	});
});
