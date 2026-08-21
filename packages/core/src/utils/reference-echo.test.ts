/**
 * Deterministic unit coverage for the reference-echo safety gate. Both helpers
 * are pure, so every case is an exact input/output assertion.
 *
 * This is a containment boundary, not formatting: a reference that fell back to
 * `message.content.text` can be an entire rendered prompt including the
 * external-content security envelope, and quoting it verbatim re-broadcasts
 * that scaffolding to chat (the 2026-08-02 live leak the module header cites).
 * The gate is a shape property, so the tests are written around its edges — the
 * exact 64- and 120-character boundaries, and which whitespace counts as
 * multi-line — because those are what a refactor moves by one and nothing else
 * would notice.
 */

import { describe, expect, it } from "vitest";
import { describeUserReference, userReferenceLogView } from "./reference-echo";

const FALLBACK = "that item";

describe("describeUserReference", () => {
	it("quotes a name-shaped reference", () => {
		expect(describeUserReference("Ada Lovelace", FALLBACK)).toBe(
			'"Ada Lovelace"',
		);
	});

	it("trims before quoting and before measuring", () => {
		expect(describeUserReference("  Ada  ", FALLBACK)).toBe('"Ada"');
		// 64 content characters plus surrounding whitespace still passes: the
		// length gate applies to the trimmed value.
		const exactly64 = "a".repeat(64);
		expect(describeUserReference(`  ${exactly64}  `, FALLBACK)).toBe(
			`"${exactly64}"`,
		);
	});

	it("falls back for an empty or whitespace-only reference", () => {
		expect(describeUserReference("", FALLBACK)).toBe(FALLBACK);
		expect(describeUserReference("   ", FALLBACK)).toBe(FALLBACK);
		expect(describeUserReference("\n\t ", FALLBACK)).toBe(FALLBACK);
	});

	it("holds the 64-character boundary exactly", () => {
		expect(describeUserReference("a".repeat(64), FALLBACK)).toBe(
			`"${"a".repeat(64)}"`,
		);
		expect(describeUserReference("a".repeat(65), FALLBACK)).toBe(FALLBACK);
	});

	it("falls back for anything multi-line", () => {
		// A rendered prompt is never single-line, which is the whole gate.
		expect(describeUserReference("line one\nline two", FALLBACK)).toBe(
			FALLBACK,
		);
		expect(describeUserReference("line one\rline two", FALLBACK)).toBe(
			FALLBACK,
		);
		expect(describeUserReference("a\r\nb", FALLBACK)).toBe(FALLBACK);
		expect(describeUserReference("trailing\n", FALLBACK)).toBe('"trailing"');
	});

	it("treats a horizontal tab as name-shaped", () => {
		// Only CR and LF are rejected; a tab survives the gate. Pinned because it
		// is the nearest neighbour to the rejected characters.
		expect(describeUserReference("a\tb", FALLBACK)).toBe('"a\tb"');
	});

	it("returns the caller's fallback verbatim", () => {
		expect(describeUserReference("x".repeat(200), "the requested target")).toBe(
			"the requested target",
		);
	});

	it("handles non-string arguments safely without throwing", () => {
		expect(
			describeUserReference(undefined as unknown as string, FALLBACK),
		).toBe(FALLBACK);
		expect(describeUserReference(null as unknown as string, FALLBACK)).toBe(
			FALLBACK,
		);
		expect(describeUserReference(123 as unknown as string, FALLBACK)).toBe(
			FALLBACK,
		);
		expect(
			describeUserReference(
				undefined as unknown as string,
				undefined as unknown as string,
			),
		).toBe("target");
	});
});

describe("userReferenceLogView", () => {
	it("collapses every whitespace run to a single space and trims", () => {
		expect(userReferenceLogView("  a \n\t  b \r\n c  ")).toBe("a b c");
	});

	it("returns a short reference unchanged after collapsing", () => {
		expect(userReferenceLogView("plain reference")).toBe("plain reference");
		expect(userReferenceLogView("")).toBe("");
		expect(userReferenceLogView("   ")).toBe("");
	});

	it("handles non-string arguments safely without throwing", () => {
		expect(userReferenceLogView(undefined as unknown as string)).toBe("");
		expect(userReferenceLogView(null as unknown as string)).toBe("");
		expect(userReferenceLogView(42 as unknown as string)).toBe("");
	});

	it("holds the 120-character boundary exactly", () => {
		const exactly120 = "a".repeat(120);
		expect(userReferenceLogView(exactly120)).toBe(exactly120);

		const over = "a".repeat(121);
		expect(userReferenceLogView(over)).toBe(`${"a".repeat(119)}…`);
	});

	it("measures the boundary after collapsing, not before", () => {
		// 150 raw characters that collapse to 89 must survive intact — clamping on
		// the raw length would truncate this.
		const spaced = "ab   ".repeat(30);
		expect(spaced.length).toBeGreaterThan(120);

		const collapsed = userReferenceLogView(spaced);
		expect(collapsed).toBe(Array.from({ length: 30 }, () => "ab").join(" "));
		expect(collapsed.length).toBeLessThanOrEqual(120);
		expect(collapsed).not.toContain("…");
	});

	it("appends exactly one ellipsis character when clamping", () => {
		const clamped = userReferenceLogView("b".repeat(500));
		expect(clamped).toHaveLength(120);
		expect(clamped.endsWith("…")).toBe(true);
		expect(clamped.slice(0, 119)).toBe("b".repeat(119));
	});

	it("keeps surrogate pairs intact when truncating at 120-char boundary", () => {
		const text = `${"a".repeat(118)}🦊${"b".repeat(50)}`;
		const clamped = userReferenceLogView(text);
		expect(clamped.length).toBeLessThanOrEqual(120);
		expect(clamped.isWellFormed?.() ?? true).toBe(true);
		expect(clamped.endsWith("…")).toBe(true);
		expect(clamped).not.toContain("\uD83E");
	});

	it("sanitizes lone surrogates before clamping", () => {
		const lone = `bad \uD800 ${"c".repeat(200)}`;
		const clamped = userReferenceLogView(lone);
		expect(clamped).toContain("\uFFFD");
		expect(clamped.isWellFormed?.() ?? true).toBe(true);
		expect(clamped.length).toBeLessThanOrEqual(120);
	});
});
