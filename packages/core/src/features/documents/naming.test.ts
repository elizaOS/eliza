/**
 * Tests for document naming helpers and surrogate-safe truncateDocumentLabel.
 */

import { describe, expect, it } from "vitest";
import {
	createDocumentNoteFilename,
	DOCUMENT_TITLE_MAX_LENGTH,
	deriveDocumentTitle,
	stripDocumentFilenameExtension,
	truncateDocumentLabel,
} from "./naming.ts";

function isWellFormed(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				return false;
			}
			index += 1;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

describe("truncateDocumentLabel well-formed Unicode boundaries", () => {
	it("keeps surrogate pairs intact when truncating at 80-char boundary", () => {
		const budget = DOCUMENT_TITLE_MAX_LENGTH - 1; // 79
		const text = `${"a".repeat(budget - 1)}🦊${"b".repeat(50)}`;
		const out = truncateDocumentLabel(text);
		expect(out.length).toBeLessThanOrEqual(DOCUMENT_TITLE_MAX_LENGTH);
		expect(isWellFormed(out)).toBe(true);
		expect(out.endsWith("…")).toBe(true);
		expect(out).not.toContain("\uD83E");
	});

	it("preserves fitting emoji under limit", () => {
		const text = `${"a".repeat(70)}🦊`;
		const out = truncateDocumentLabel(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("sanitizes lone surrogates before truncation", () => {
		const lone = `title \uD800 ${"b".repeat(200)}`;
		const out = truncateDocumentLabel(lone);
		expect(out).toContain("\uFFFD");
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBeLessThanOrEqual(DOCUMENT_TITLE_MAX_LENGTH);
	});

	it("deriveDocumentTitle uses surrogate-safe truncation on heading line", () => {
		const budget = DOCUMENT_TITLE_MAX_LENGTH - 1;
		const content = `# ${"a".repeat(budget - 1)}🦊${"b".repeat(50)}\n\nBody content.`;
		const title = deriveDocumentTitle(content);
		expect(title.length).toBeLessThanOrEqual(DOCUMENT_TITLE_MAX_LENGTH);
		expect(isWellFormed(title)).toBe(true);
		expect(title.endsWith("…")).toBe(true);
	});

	it("handles filenames and extensions properly", () => {
		expect(stripDocumentFilenameExtension("report.final.pdf")).toBe(
			"report.final",
		);
		expect(createDocumentNoteFilename("My Note & Plan!")).toBe(
			"my-note-plan.txt",
		);
	});
});
