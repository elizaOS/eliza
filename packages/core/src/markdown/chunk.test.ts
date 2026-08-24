import { describe, expect, it } from "vitest";
import {
	assertValidMarkdownChunkLimit,
	chunkByParagraph,
	chunkMarkdownText,
	chunkText,
	MARKDOWN_CHUNK_LIMIT_INVALID,
} from "./chunk.ts";

function capturedCode(fn: () => void): string | undefined {
	try {
		fn();
		return undefined;
	} catch (error) {
		return (error as { code?: string }).code;
	}
}

describe("assertValidMarkdownChunkLimit", () => {
	it("accepts positive safe integers", () => {
		expect(
			capturedCode(() => assertValidMarkdownChunkLimit(1)),
		).toBeUndefined();
		expect(
			capturedCode(() => assertValidMarkdownChunkLimit(140)),
		).toBeUndefined();
		expect(
			capturedCode(() =>
				assertValidMarkdownChunkLimit(Number.MAX_SAFE_INTEGER),
			),
		).toBeUndefined();
	});

	it("rejects zero, negatives, fractions and non-finite limits", () => {
		const invalid = [
			0,
			-1,
			1.5,
			NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
		];
		for (const limit of invalid) {
			expect(capturedCode(() => assertValidMarkdownChunkLimit(limit))).toBe(
				MARKDOWN_CHUNK_LIMIT_INVALID,
			);
		}
	});
});

describe("chunkText", () => {
	it("returns [] for empty input and the text itself when within limit", () => {
		expect(chunkText("", 10)).toEqual([]);
		expect(chunkText("abc", 10)).toEqual(["abc"]);
		expect(chunkText("abcdef", 6)).toEqual(["abcdef"]);
	});

	it("prefers breaking at newlines", () => {
		const text = "line one\nline two\nline three";
		const chunks = chunkText(text, 12);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(12);
		}
		// Content survives the split (whitespace separators may be trimmed).
		expect(chunks.join("").replace(/\s+/g, "")).toBe("lineonelinetwolinethree");
	});

	it("breaks at the last word boundary when no newline is available", () => {
		const chunks = chunkText("alpha beta gamma delta", 11);
		expect(chunks).toEqual(["alpha beta", "gamma delta"]);
	});

	it("hard-breaks at the limit for unbroken text", () => {
		const chunks = chunkText("abcdefghijklmnopqrstuvwxyz", 8);
		expect(chunks).toEqual(["abcdefgh", "ijklmnop", "qrstuvwx", "yz"]);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(8);
		}
	});

	it("does not break inside parentheses", () => {
		const text =
			"see (this is a long\nparenthesized remark) and then more words here";
		const chunks = chunkText(text, 20);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(20);
		}
	});

	it("never splits a surrogate pair", () => {
		const emoji = "🚀";
		const text = `prefix ${emoji} suffix words`;
		const chunks = chunkText(text, 9);
		for (const chunk of chunks) {
			expect(chunk.includes("\uFFFD")).toBe(false);
		}
		// The pair must appear whole in exactly one chunk.
		const occurrences = chunks.filter((c) => c.includes(emoji)).length;
		expect(occurrences).toBe(1);
	});

	it("handles limit=1 without stalling", () => {
		const chunks = chunkText("ab cd", 1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeGreaterThan(0);
		}
		expect(chunks.join("").replace(/ /g, "")).toBe("abcd");
	});
});

describe("chunkByParagraph", () => {
	it("returns [] for empty input", () => {
		expect(chunkByParagraph("", 10)).toEqual([]);
	});

	it("keeps a single paragraph intact when within limit", () => {
		expect(chunkByParagraph("one paragraph", 100)).toEqual(["one paragraph"]);
	});

	it("splits on blank lines into paragraph chunks", () => {
		const text = "para one\n\npara two\n\npara three";
		expect(chunkByParagraph(text, 100)).toEqual([
			"para one",
			"para two",
			"para three",
		]);
	});

	it("does not split on blank lines inside fenced code blocks", () => {
		const text = "intro\n\n```\ncode\n\nstill code\n```\n\nafter";
		const chunks = chunkByParagraph(text, 100);
		// The fence body must stay inside a single chunk (not split at its blank line).
		expect(chunks.length).toBe(3);
		expect(chunks[1]).toContain("```");
	});

	it("falls back to length-based splitting for oversized paragraphs", () => {
		const long = "word ".repeat(50).trim();
		const chunks = chunkByParagraph(long, 20);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(20);
		}
	});

	it("keeps oversized paragraphs whole when splitLongParagraphs is false", () => {
		const long = "word ".repeat(50).trim();
		expect(chunkByParagraph(long, 20, { splitLongParagraphs: false })).toEqual([
			long,
		]);
	});
});

describe("chunkMarkdownText", () => {
	it("returns [] for empty input", () => {
		expect(chunkMarkdownText("", 10)).toEqual([]);
	});

	it("keeps short text as a single chunk", () => {
		expect(chunkMarkdownText("# title\n\nbody", 100)).toEqual([
			"# title\n\nbody",
		]);
	});

	it("closes and reopens a code fence split across chunks", () => {
		const code = "```js\n" + "const x = 1;\n".repeat(20) + "```";
		const chunks = chunkMarkdownText(code, 30);
		expect(chunks.length).toBeGreaterThan(1);
		// Every non-final chunk that started inside a fence must end with a close line.
		const openCount = code.split("```").length - 1;
		const closeCount = chunks.reduce(
			(sum, c) => sum + (c.match(/```/g)?.length ?? 0),
			0,
		);
		// Reopening adds markers: total marker count = original + 2*(chunks-1)
		expect(closeCount).toBe(openCount + 2 * (chunks.length - 1));
		// The full payload must survive the round trip once markers are removed.
		const joined = chunks.join("");
		expect(joined.replace(/```/g, "").replace(/\n{2,}/g, "\n")).toContain(
			"const x = 1;",
		);
	});

	it("never emits a chunk over the limit", () => {
		const text = "some words ".repeat(30);
		for (const chunk of chunkMarkdownText(text, 25)) {
			expect(chunk.length).toBeLessThanOrEqual(25);
		}
	});
});
