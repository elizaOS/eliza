/**
 * Unit tests for binary MIME type sniffing.
 */

import { describe, expect, it } from "vitest";
import { sniffMime } from "./mime-sniffer.js";

describe("mime-sniffer", () => {
	it("returns undefined for undefined buffer", async () => {
		expect(await sniffMime(undefined)).toBeUndefined();
	});

	it("sniffs PNG image magic bytes", async () => {
		const pngHeader = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
			0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
			0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
		]);

		const mime = await sniffMime(pngHeader);
		expect(mime).toBe("image/png");
	});

	it("sniffs JPEG image magic bytes", async () => {
		const jpegHeader = Buffer.from([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
			0x01, 0x01, 0x00, 0x60, 0x00, 0x60, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
		]);

		const mime = await sniffMime(jpegHeader);
		expect(mime).toBe("image/jpeg");
	});

	it("returns undefined for non-identifiable random or text bytes", async () => {
		const plainText = Buffer.from(
			"Hello world plain text content without magic header",
		);
		expect(await sniffMime(plainText)).toBeUndefined();
	});
});
