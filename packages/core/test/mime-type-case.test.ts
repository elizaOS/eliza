import { expect, test } from "vitest";
import { ContentType } from "../src/types/primitives";
import { getContentTypeFromMimeType } from "../src/utils";

test("MIME classification accepts case-insensitive type and subtype names", () => {
	expect(getContentTypeFromMimeType("Image/PNG")).toBe(ContentType.IMAGE);
	expect(getContentTypeFromMimeType("VIDEO/MP4")).toBe(ContentType.VIDEO);
	expect(getContentTypeFromMimeType("Audio/MPEG")).toBe(ContentType.AUDIO);
	expect(getContentTypeFromMimeType("Text/Plain")).toBe(ContentType.DOCUMENT);
	expect(getContentTypeFromMimeType("Application/PDF")).toBe(
		ContentType.DOCUMENT,
	);
});
