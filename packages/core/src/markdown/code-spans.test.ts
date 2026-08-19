/**
 * Deterministic tests for `buildCodeSpanIndex`: honest fence/inline membership
 * plus a hostile thousands-of-fences document that used to hang the per-character
 * linear span scan on origin.
 */
import { describe, expect, it } from "vitest";
import { buildCodeSpanIndex } from "./code-spans.ts";

describe("buildCodeSpanIndex", () => {
	it("marks inline backticks and fenced blocks, not surrounding prose", () => {
		const markdown = ["before `code` after", "```", "block", "```", "end"].join(
			"\n",
		);
		const index = buildCodeSpanIndex(markdown);
		expect(index.isInside(markdown.indexOf("code"))).toBe(true);
		expect(index.isInside(markdown.indexOf("block"))).toBe(true);
		expect(index.isInside(markdown.indexOf("before"))).toBe(false);
		expect(index.isInside(markdown.indexOf("end"))).toBe(false);
	});

	it("does not hang on thousands of fences followed by a long prose tail", () => {
		const fences = 16_000;
		const tail = 300_000;
		let text = "";
		for (let i = 0; i < fences; i++) text += "```\nx\n```\n";
		text += "y".repeat(tail);
		const started = performance.now();
		const index = buildCodeSpanIndex(text);
		expect(performance.now() - started).toBeLessThan(200);
		expect(index.isInside(2)).toBe(true);
		expect(index.isInside(text.length - 1)).toBe(false);
	});
});
