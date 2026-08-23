/**
 * Regression coverage for the connector's duplicate-suppression log preview.
 * Exercises the exported buildDuplicateTextPreview from messages.ts with real
 * (unmocked) core helpers: Discord text is untrusted, so a plain slice could
 * emit a lone surrogate or split an astral pair into the structured log.
 */
import { describe, expect, it } from "vitest";
import { buildDuplicateTextPreview } from "../messages";

describe("buildDuplicateTextPreview", () => {
	it("never emits a lone surrogate at the truncation boundary", () => {
		const text = `${"a".repeat(199)}\uD800${"b".repeat(10)}`;
		const naive = text.replace(/\s+/g, " ").trim().slice(0, 200);
		expect(naive.charCodeAt(199).toString(16)).toBe("d800");

		const preview = buildDuplicateTextPreview(text);
		expect(preview.length).toBeLessThanOrEqual(200);
		expect(preview.isWellFormed()).toBe(true);
		expect(preview).not.toContain("\uD800");
	});

	it("does not split an astral pair at the boundary", () => {
		const text = `${"x".repeat(199)}🦊${"y".repeat(10)}`;
		const naive = text.replace(/\s+/g, " ").trim().slice(0, 200);
		expect(naive.isWellFormed()).toBe(false);

		const preview = buildDuplicateTextPreview(text);
		expect(preview.length).toBeLessThanOrEqual(200);
		expect(preview.isWellFormed()).toBe(true);
		expect(preview).toBe("x".repeat(199));
	});

	it("collapses whitespace and caps the preview at 200 code units", () => {
		expect(buildDuplicateTextPreview("a".repeat(500))).toHaveLength(200);
		expect(buildDuplicateTextPreview("  hello \n\t world  ")).toBe(
			"hello world",
		);
	});
});
