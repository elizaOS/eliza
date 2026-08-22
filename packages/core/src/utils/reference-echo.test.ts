/**
 * Deterministic unit coverage for the reference-echo safety gate. The bounded
 * helper contains untrusted envelope fallbacks, while the explicit complete
 * helper preserves audited model/action values without semantic shortening.
 *
 * User-facing quoting remains shape-gated, while machine-facing values preserve
 * complete normalized content so downstream model/action state is not silently
 * shortened.
 */

import { describe, expect, it } from "vitest";
import {
	completeUserReferenceView,
	describeUserReference,
	userReferenceLogView,
} from "./reference-echo";

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
		// 150 raw characters that collapse to 89 survive intact.
		const spaced = "ab   ".repeat(30);
		expect(spaced.length).toBeGreaterThan(120);

		const collapsed = userReferenceLogView(spaced);
		expect(collapsed).toBe(Array.from({ length: 30 }, () => "ab").join(" "));
		expect(collapsed.length).toBeLessThanOrEqual(120);
		expect(collapsed).not.toContain("…");
	});

	it("contains complete blob-shaped references", () => {
		const clamped = userReferenceLogView("b".repeat(500));
		expect(clamped).toHaveLength(120);
		expect(clamped).toBe(`${"b".repeat(119)}…`);
	});

	it("keeps surrogate pairs intact at the containment boundary", () => {
		const text = `${"a".repeat(118)}🦊${"b".repeat(50)}`;
		const clamped = userReferenceLogView(text);
		expect(clamped.length).toBeLessThanOrEqual(120);
		expect(clamped.isWellFormed?.() ?? true).toBe(true);
		expect(clamped.endsWith("…")).toBe(true);
	});

	it("sanitizes lone surrogates before containment", () => {
		const lone = `bad \uD800 ${"c".repeat(200)}`;
		const clamped = userReferenceLogView(lone);
		expect(clamped).toContain("\uFFFD");
		expect(clamped.isWellFormed?.() ?? true).toBe(true);
		expect(clamped.length).toBeLessThanOrEqual(120);
	});
});

describe("completeUserReferenceView", () => {
	it("preserves complete normalized long references", () => {
		const reference = `${"a".repeat(180)} 🦊 ${"b".repeat(180)} tail`;
		expect(completeUserReferenceView(reference)).toBe(reference);
	});

	it("collapses whitespace and normalizes malformed Unicode without loss", () => {
		const reference = `start\n\t${"x".repeat(180)}\uD800 tail`;
		expect(completeUserReferenceView(reference)).toBe(
			`start ${"x".repeat(180)}\uFFFD tail`,
		);
	});
});
