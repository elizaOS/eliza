/**
 * Tests for complete, Unicode-safe document naming helpers.
 */

import { describe, expect, it } from "vitest";
import {
	createDocumentNoteFilename,
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

describe("truncateDocumentLabel complete Unicode values", () => {
	it("preserves content beyond the former 80-character boundary", () => {
		const text = `${"a".repeat(78)}🦊${"b".repeat(50)}`;
		const out = truncateDocumentLabel(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("preserves fitting emoji under limit", () => {
		const text = `${"a".repeat(70)}🦊`;
		const out = truncateDocumentLabel(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("sanitizes lone surrogates without shortening", () => {
		const lone = `title \uD800 ${"b".repeat(200)}`;
		const out = truncateDocumentLabel(lone);
		expect(out).toContain("\uFFFD");
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(lone.length);
	});

	it("deriveDocumentTitle preserves a complete heading line", () => {
		const expected = `${"a".repeat(78)}🦊${"b".repeat(50)}`;
		const content = `# ${expected}\n\nBody content.`;
		const title = deriveDocumentTitle(content);
		expect(title).toBe(expected);
		expect(isWellFormed(title)).toBe(true);
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
