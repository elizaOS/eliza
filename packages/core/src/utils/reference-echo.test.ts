/**
 * Deterministic unit coverage for the reference-echo safety gate. Both helpers
 * are pure, so every case is an exact input/output assertion.
 *
 * User-facing quoting remains shape-gated, while machine-facing values preserve
 * complete normalized content so downstream model/action state is not silently
 * shortened.
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

	it("preserves content beyond the former 120-character boundary", () => {
		const exactly120 = "a".repeat(120);
		expect(userReferenceLogView(exactly120)).toBe(exactly120);

		const over = "a".repeat(121);
		expect(userReferenceLogView(over)).toBe(over);
	});

	it("measures the boundary after collapsing, not before", () => {
		// 150 raw characters that collapse to 89 survive intact.
		const spaced = "ab   ".repeat(30);
		expect(spaced.length).toBeGreaterThan(120);

		const collapsed = userReferenceLogView(spaced);
		expect(collapsed).toBe(Array.from({ length: 30 }, () => "ab").join(" "));
		expect(collapsed.length).toBeLessThanOrEqual(120);
		expect(collapsed).not.toContain("…");
	});

	it("preserves complete long references", () => {
		const complete = userReferenceLogView("b".repeat(500));
		expect(complete).toBe("b".repeat(500));
		expect(complete).not.toContain("…");
	});

	it("keeps complete surrogate pairs beyond the former boundary", () => {
		const text = `${"a".repeat(118)}🦊${"b".repeat(50)}`;
		const complete = userReferenceLogView(text);
		expect(complete).toBe(text);
		expect(complete.isWellFormed?.() ?? true).toBe(true);
	});

	it("sanitizes lone surrogates without shortening", () => {
		const lone = `bad \uD800 ${"c".repeat(200)}`;
		const complete = userReferenceLogView(lone);
		expect(complete).toBe(`bad \uFFFD ${"c".repeat(200)}`);
		expect(complete.isWellFormed?.() ?? true).toBe(true);
	});
});
