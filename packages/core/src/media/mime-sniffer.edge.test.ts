/**
 * Unit tests for the edge magic-byte MIME sniffer. Deterministic suite that
 * drives the real `sniffMime` implementation with raw byte inputs; no mocks,
 * no network, no clock dependence.
 */

import { describe, expect, it } from "vitest";
import { sniffMime } from "./mime-sniffer.edge.js";

const charCodes = (text: string): number[] =>
	Array.from(text, (char) => char.charCodeAt(0));

const bytes = (...parts: ReadonlyArray<number | string>): Uint8Array => {
	const out: number[] = [];
	for (const part of parts) {
		if (typeof part === "string") out.push(...charCodes(part));
		else out.push(part);
	}
	return Uint8Array.from(out);
};

const riffSizeField = [0x00, 0x01, 0x02, 0x03];

interface SignatureCase {
	name: string;
	mime: string;
	build: () => Uint8Array;
	mutateIndex: number;
}

const SIGNATURES: SignatureCase[] = [
	{
		name: "png",
		mime: "image/png",
		mutateIndex: 0,
		build: () => bytes(0x89, "PNG\r\n\u001a\n"),
	},
	{
		name: "jpeg",
		mime: "image/jpeg",
		mutateIndex: 0,
		build: () => bytes(0xff, 0xd8, 0xff),
	},
	{
		name: "gif87a",
		mime: "image/gif",
		mutateIndex: 5,
		build: () => bytes("GIF87a"),
	},
	{
		name: "gif89a",
		mime: "image/gif",
		mutateIndex: 5,
		build: () => bytes("GIF89a"),
	},
	{
		name: "webp",
		mime: "image/webp",
		mutateIndex: 8,
		build: () => bytes("RIFF", ...riffSizeField, "WEBP"),
	},
	{
		name: "pdf",
		mime: "application/pdf",
		mutateIndex: 0,
		build: () => bytes("%PDF-"),
	},
	{
		name: "zip",
		mime: "application/zip",
		mutateIndex: 2,
		build: () => bytes(0x50, 0x4b, 0x03, 0x04),
	},
	{
		name: "gzip",
		mime: "application/gzip",
		mutateIndex: 1,
		build: () => bytes(0x1f, 0x8b),
	},
	{
		name: "ogg",
		mime: "audio/ogg",
		mutateIndex: 3,
		build: () => bytes("OggS"),
	},
	{
		name: "id3",
		mime: "audio/mpeg",
		mutateIndex: 0,
		build: () => bytes("ID3"),
	},
	{
		name: "wav",
		mime: "audio/wav",
		mutateIndex: 11,
		build: () => bytes("RIFF", ...riffSizeField, "WAVE"),
	},
	{
		name: "mp4",
		mime: "video/mp4",
		mutateIndex: 4,
		build: () => bytes(0x00, 0x00, 0x00, 0x18, "ftyp"),
	},
];

const TRAILING_GARBAGE = [0xde, 0xad, 0xbe, 0xef];

describe("sniffMime", () => {
	it("resolves undefined when called without a buffer", async () => {
		expect(await sniffMime()).toBeUndefined();
	});

	it("resolves undefined for null passed through a runtime-only cast", async () => {
		const nullBuffer = null as unknown as Uint8Array;
		expect(await sniffMime(nullBuffer)).toBeUndefined();
	});

	it("resolves undefined for an empty Uint8Array", async () => {
		expect(await sniffMime(new Uint8Array())).toBeUndefined();
	});

	it("resolves undefined for unrelated bytes", async () => {
		expect(
			await sniffMime(bytes("just some plain text payload")),
		).toBeUndefined();
	});

	it("returns a promise that resolves to the detected type", async () => {
		const pending = sniffMime(bytes("RIFF", ...riffSizeField, "WEBP"));
		expect(pending).toBeInstanceOf(Promise);
		expect(await pending).toBe("image/webp");
	});

	describe("supported signatures", () => {
		for (const sig of SIGNATURES) {
			it(`detects ${sig.mime} from a minimal ${sig.name} signature`, async () => {
				expect(await sniffMime(sig.build())).toBe(sig.mime);
			});

			it(`still detects ${sig.mime} when ${sig.name} carries trailing bytes`, async () => {
				const padded = bytes(...sig.build(), ...TRAILING_GARBAGE);
				expect(await sniffMime(padded)).toBe(sig.mime);
			});
		}
	});

	describe("rejections", () => {
		for (const sig of SIGNATURES) {
			it(`rejects ${sig.name} when a checked signature byte is corrupted`, async () => {
				const corrupted = sig.build();
				corrupted[sig.mutateIndex] ^= 0xff;
				expect(corrupted[sig.mutateIndex]).not.toEqual(
					sig.build()[sig.mutateIndex],
				);
				expect(await sniffMime(corrupted)).toBeUndefined();
			});

			it(`rejects ${sig.name} when the signature is one byte short`, async () => {
				const truncated = sig.build().slice(0, sig.build().length - 1);
				expect(await sniffMime(truncated)).toBeUndefined();
			});

			it(`rejects ${sig.name} when shifted one byte off its expected offset`, async () => {
				const shifted = bytes(0x00, ...sig.build());
				expect(await sniffMime(shifted)).toBeUndefined();
			});
		}
	});

	describe("riff subtype selection", () => {
		it("selects image/webp for RIFF containers declaring WEBP", async () => {
			expect(await sniffMime(bytes("RIFF", ...riffSizeField, "WEBP"))).toBe(
				"image/webp",
			);
		});

		it("selects audio/wav for RIFF containers declaring WAVE", async () => {
			expect(await sniffMime(bytes("RIFF", ...riffSizeField, "WAVE"))).toBe(
				"audio/wav",
			);
		});

		it("resolves undefined for a RIFF container with an unrecognized subtype", async () => {
			expect(
				await sniffMime(bytes("RIFF", ...riffSizeField, "JUNK")),
			).toBeUndefined();
		});
	});

	describe("branch ordering", () => {
		it("reports application/pdf before the mp4 fallback for '%PDF-ftyp'", async () => {
			expect(await sniffMime(bytes("%PDF-", "ftyp"))).toBe("application/pdf");
		});

		it("reports audio/ogg before the mp4 fallback for 'OggSftyp'", async () => {
			expect(await sniffMime(bytes("OggSftyp"))).toBe("audio/ogg");
		});

		it("reports audio/mpeg before the mp4 fallback for 'ID3ftyp'", async () => {
			expect(await sniffMime(bytes("ID3ftyp"))).toBe("audio/mpeg");
		});
	});

	describe("input representation", () => {
		it("sniffs a Node Buffer identically to its Uint8Array equivalent", async () => {
			const asArray = new Uint8Array([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
			]);
			const asBuffer = Buffer.from(asArray);
			expect(await sniffMime(asBuffer)).toBe(await sniffMime(asArray));
			expect(await sniffMime(asBuffer)).toBe("image/png");
		});

		it("requires the complete eight-byte ftyp window", async () => {
			expect(await sniffMime(bytes(0x00, 0x00, 0x00, 0x18, "ftyp"))).toBe(
				"video/mp4",
			);
			expect(
				await sniffMime(bytes(0x00, 0x00, 0x00, 0x18, "fty")),
			).toBeUndefined();
		});
	});
});
