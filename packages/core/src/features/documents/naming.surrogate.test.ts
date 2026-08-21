/** Surrogate safety for stripDocumentFilenameExtension in naming.ts. */
import { describe, expect, test } from "vitest";
import { stripDocumentFilenameExtension } from "./naming.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return true;
}

describe("document naming stripDocumentFilenameExtension surrogate safety", () => {
	test("emoji before extension stripped cleanly without lone surrogate", () => {
		const fox = "🦊";
		const input = `Report_${fox}.pdf`;
		const out = stripDocumentFilenameExtension(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(`Report_${fox}`);
		expect(() => JSON.stringify({ out })).not.toThrow();
	});

	test("filename with multiple dots and emojis stripped at last dot", () => {
		const fox = "🦊";
		const input = `document.v1.${fox}.tar.gz`;
		const out = stripDocumentFilenameExtension(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(`document.v1.${fox}.tar`);
	});

	test("lone high surrogate in filename sanitized safely", () => {
		const badInput = "Bad \ud800 document.docx";
		const out = stripDocumentFilenameExtension(badInput);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("\ud800")).toBe(false);
	});

	test("sweep emoji placements in filename stay well-formed", () => {
		const fox = "🦊";
		for (let offset = 0; offset <= 5; offset++) {
			const input = `${"a".repeat(offset)}${fox}${"b".repeat(5)}.markdown`;
			const out = stripDocumentFilenameExtension(input);
			expect(isWellFormed(out)).toBe(true);
			expect(() => JSON.stringify({ out })).not.toThrow();
		}
	});
});
