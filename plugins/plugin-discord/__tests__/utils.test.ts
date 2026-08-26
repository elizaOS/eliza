/**
 * Behavioral coverage for discord utils.getAttachmentFileName.
 * Verifies extension extraction guards against dot-less short paths and
 * domain-dot confusion, falling back to contentType or .txt.
 */

import { describe, expect, it } from "vitest";
import { getAttachmentFileName } from "../utils.ts";

describe("getAttachmentFileName", () => {
	it("returns id + .txt when url has no dot and no contentType", () => {
		expect(
			getAttachmentFileName({
				url: "https://cdn.example.com/a",
				id: "123",
				title: null,
				contentType: undefined,
			} as never),
		).toBe("123.txt");
	});

	it("does not treat short dot-less pathname as extension", () => {
		expect(
			getAttachmentFileName({
				url: "https://example.com/b",
				id: "x",
				title: null,
				contentType: undefined,
			} as never),
		).toBe("x.txt");
	});

	it("uses contentType fallback when url has no extension", () => {
		expect(
			getAttachmentFileName({
				url: "https://example.com/media/abc123",
				id: "x",
				title: "myfile",
				contentType: "image",
			} as never),
		).toBe("myfile.png");
	});

	it("extracts valid extension when present", () => {
		expect(
			getAttachmentFileName({
				url: "https://example.com/file.jpg",
				id: "1",
				title: null,
				contentType: undefined,
			} as never),
		).toBe("1.jpg");
	});

	it("preserves baseName when it already has extension", () => {
		expect(
			getAttachmentFileName({
				url: "https://example.com/file.jpg",
				id: "1",
				title: "report.pdf",
				contentType: undefined,
			} as never),
		).toBe("report.pdf");
	});

	it("does not use domain dot as extension", () => {
		expect(
			getAttachmentFileName({
				url: "https://example.com/file",
				id: "1",
				title: undefined,
				contentType: undefined,
			} as never),
		).toBe("1.txt");
	});

	it("rejects extension containing slash", () => {
		expect(
			getAttachmentFileName({
				url: "https://cdn.example.com/a",
				id: "123",
				title: "doc",
				contentType: undefined,
			} as never),
		).toBe("doc.txt");
	});

	it("falls back to txt for invalid media url without parsable extension", () => {
		expect(
			getAttachmentFileName({
				url: "not-a-url",
				id: "abc",
				title: null,
				contentType: undefined,
			} as never),
		).toBe("abc.txt");
	});
});
