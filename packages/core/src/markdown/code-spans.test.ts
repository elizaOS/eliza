/**
 * Deterministic tests for the real code-span index: fence, inline, streaming,
 * and boundary membership plus hostile fence-heavy input that exposed the old
 * per-character linear scan.
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

	it("uses half-open span boundaries and rejects out-of-range positions", () => {
		const markdown = "a `bc` d\n~~~\nef\n~~~\ng";
		const index = buildCodeSpanIndex(markdown);
		const inlineStart = markdown.indexOf("`");
		const inlineEnd = markdown.indexOf("`", inlineStart + 1) + 1;
		const fenceStart = markdown.indexOf("~~~");
		const fenceEnd = markdown.indexOf("~~~", fenceStart + 3) + 3;

		expect(index.isInside(inlineStart)).toBe(true);
		expect(index.isInside(inlineEnd - 1)).toBe(true);
		expect(index.isInside(inlineEnd)).toBe(false);
		expect(index.isInside(fenceStart)).toBe(true);
		expect(index.isInside(fenceEnd - 1)).toBe(true);
		expect(index.isInside(fenceEnd)).toBe(false);
		expect(index.isInside(-1)).toBe(false);
		expect(index.isInside(markdown.length)).toBe(false);
	});

	it("preserves an open inline delimiter across streamed chunks", () => {
		const first = buildCodeSpanIndex("before ``open");
		expect(first.inlineState).toEqual({ open: true, ticks: 2 });

		const secondText = " across`` after";
		const second = buildCodeSpanIndex(secondText, first.inlineState);
		expect(second.inlineState).toEqual({ open: false, ticks: 0 });
		expect(second.isInside(secondText.indexOf("across"))).toBe(true);
		expect(second.isInside(secondText.indexOf("after"))).toBe(false);
	});

	it("ignores backticks inside multiple fenced blocks", () => {
		const markdown = [
			"```ts",
			"`not inline`",
			"```",
			"plain",
			"~~~md",
			"``also fenced``",
			"~~~",
			"tail `inline`",
		].join("\n");
		const index = buildCodeSpanIndex(markdown);

		expect(index.isInside(markdown.indexOf("not inline"))).toBe(true);
		expect(index.isInside(markdown.indexOf("also fenced"))).toBe(true);
		expect(index.isInside(markdown.indexOf("plain"))).toBe(false);
		expect(
			index.isInside(markdown.indexOf("inline", markdown.indexOf("tail"))),
		).toBe(true);
	});

	it("bounds work for thousands of fences followed by a long prose tail", () => {
		const fences = 16_000;
		const tail = 300_000;
		const text = `${"```\nx\n```\n".repeat(fences)}${"y".repeat(tail)}`;
		const index = buildCodeSpanIndex(text);
		expect(index.isInside(2)).toBe(true);
		expect(index.isInside(text.length - 1)).toBe(false);
	});
});
