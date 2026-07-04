/**
 * Pure-function unit tests for the document helpers in utils.ts — content-hash
 * id generation, filename/title derivation from untrusted text, and
 * source/base64 classification, all asserted directly with no runtime.
 */
import { describe, expect, it } from "vitest";
import {
	createDocumentNoteFilename,
	deriveDocumentTitle,
	extractFirstLines,
	generateContentBasedId,
	looksLikeBase64,
	normalizeDocumentSourceValue,
	normalizeS3Url,
	stripDocumentFilenameExtension,
} from "./utils.ts";

/**
 * Document helpers derive titles/filenames/ids from untrusted content.
 * generateContentBasedId must be a stable content hash (dedupe key), filename
 * derivation must produce a safe ASCII slug, and source/base64 classification
 * must be strict.
 */

describe("filename + title derivation", () => {
	it("stripDocumentFilenameExtension removes the last extension only", () => {
		expect(stripDocumentFilenameExtension("report.pdf")).toBe("report");
		expect(stripDocumentFilenameExtension("a.b.c")).toBe("a.b");
		expect(stripDocumentFilenameExtension("no-ext")).toBe("no-ext");
		expect(stripDocumentFilenameExtension(".hidden")).toBe(".hidden");
		expect(stripDocumentFilenameExtension("")).toBe("");
	});

	it("deriveDocumentTitle takes the first meaningful line, stripping markers", () => {
		expect(deriveDocumentTitle("# Title\nbody")).toBe("Title");
		expect(deriveDocumentTitle("path: /x\nReal Title")).toBe("Real Title");
		expect(deriveDocumentTitle("- bullet point")).toBe("bullet point");
		expect(deriveDocumentTitle("1. numbered")).toBe("numbered");
		expect(deriveDocumentTitle("")).toBe("Document note");
		expect(deriveDocumentTitle("", "Fallback")).toBe("Fallback");
	});

	it("createDocumentNoteFilename produces an ascii slug", () => {
		expect(createDocumentNoteFilename("My Title!")).toBe("my-title.txt");
		expect(createDocumentNoteFilename("café")).toBe("cafe.txt");
		expect(createDocumentNoteFilename("!!!")).toBe("document-note.txt");
		expect(createDocumentNoteFilename("Notes", "md")).toBe("notes.md");
	});
});

describe("classification", () => {
	it("normalizeDocumentSourceValue maps known sources, else 'unknown'", () => {
		expect(normalizeDocumentSourceValue("upload")).toBe("upload");
		expect(normalizeDocumentSourceValue("rag-service-main-upload")).toBe(
			"upload",
		);
		expect(normalizeDocumentSourceValue("eliza-default-documents")).toBe(
			"bundled",
		);
		expect(normalizeDocumentSourceValue("random")).toBe("unknown");
		expect(normalizeDocumentSourceValue(5)).toBe("unknown");
	});

	it("normalizeS3Url strips query/hash, leaves bad URLs intact", () => {
		expect(normalizeS3Url("https://b.s3.com/key?sig=abc")).toBe(
			"https://b.s3.com/key",
		);
		expect(normalizeS3Url("not a url")).toBe("not a url");
	});

	it("looksLikeBase64 requires length, padding, and char mix", () => {
		expect(looksLikeBase64("SGVsbG8gV29ybGQh")).toBe(true); // mixed-case base64
		expect(looksLikeBase64("abc")).toBe(false); // too short
		expect(looksLikeBase64("1234567890123456")).toBe(false); // no lowercase
		expect(looksLikeBase64(null)).toBe(false);
	});
});

describe("generateContentBasedId / extractFirstLines", () => {
	it("generateContentBasedId is a stable uuid keyed on content+agent", () => {
		const id = generateContentBasedId("hello", "agent-1");
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(generateContentBasedId("hello", "agent-1")).toBe(id);
		expect(generateContentBasedId("world", "agent-1")).not.toBe(id);
		expect(generateContentBasedId("hello", "agent-2")).not.toBe(id);
	});

	it("extractFirstLines returns the first N lines", () => {
		expect(extractFirstLines("a\nb\nc\nd", 2)).toBe("a\nb");
	});
});
