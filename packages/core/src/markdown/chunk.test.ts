/**
 * Coverage for markdown chunk.
 */
import { describe, expect, it } from "vitest";
import {
	assertValidMarkdownChunkLimit,
	chunkByParagraph,
	chunkText,
} from "./chunk.js";

describe("markdown chunk", () => {
	it("validates limit", () => {
		expect(() => assertValidMarkdownChunkLimit(10)).not.toThrow();
		expect(() => assertValidMarkdownChunkLimit(0)).toThrow();
		expect(() => assertValidMarkdownChunkLimit(-1)).toThrow();
		expect(() => assertValidMarkdownChunkLimit(1.5)).toThrow();
	});
	it("chunks short text", () => {
		expect(chunkText("hello", 10)).toEqual(["hello"]);
		expect(chunkText("", 10)).toEqual([]);
	});
	it("chunks long text by word", () => {
		const text = "hello world this is a test";
		const chunks = chunkText(text, 10);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.join(" ")).toContain("hello");
	});
	it("chunks by paragraph", () => {
		const text = "para1\n\npara2\n\npara3";
		const chunks = chunkByParagraph(text, 10);
		expect(chunks.length).toBeGreaterThan(1);
	});
	it("handles no paragraph separator", () => {
		expect(chunkByParagraph("short", 10)).toEqual(["short"]);
	});
});
