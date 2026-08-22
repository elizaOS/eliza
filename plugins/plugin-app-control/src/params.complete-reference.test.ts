/** Verifies complete normalized app references at the machine boundary. */

import { describe, expect, it } from "vitest";
import { targetReferenceLogView } from "./params.js";

describe("targetReferenceLogView", () => {
	it("preserves complete normalized content beyond the former cap", () => {
		const tail = "complete-tail";
		const input = `${"x".repeat(180)}\n\t${tail}`;
		expect(targetReferenceLogView(input)).toBe(`${"x".repeat(180)} ${tail}`);
	});

	it("repairs lone surrogates without dropping following content", () => {
		const rendered = targetReferenceLogView(
			`bad ${String.fromCharCode(0xd800)} complete-tail`,
		);
		expect(rendered.isWellFormed()).toBe(true);
		expect(rendered).toBe("bad \uFFFD complete-tail");
	});
});
