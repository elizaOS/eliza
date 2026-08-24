/**
 * Covers the public Markdown surface re-exported by `markdown/index`: chunking
 * (plain, paragraph-aware, fence-aware, and IR-span-preserving), fence span
 * parsing with safe-break queries, streaming inline-code indexing, frontmatter
 * parsing, and Markdown → IR conversion. Every call is driven through this
 * barrel entry point exactly as external consumers import it.
 *
 * Harness: deterministic and fully real — pure in-process modules, no mocks;
 * every expectation records observed behavior of this module.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors.ts";
import {
	buildCodeSpanIndex,
	chunkByParagraph,
	chunkMarkdownIR,
	chunkMarkdownText,
	chunkText,
	createInlineCodeState,
	findFenceSpanAt,
	isSafeFenceBreak,
	markdownToIR,
	markdownToIRWithMeta,
	parseFenceSpans,
	parseFrontmatterBlock,
} from "./index.ts";

describe("chunkText re-exported from markdown/index", () => {
	it("returns an empty array for empty input", () => {
		expect(chunkText("", 10)).toEqual([]);
	});

	it("returns a single chunk when text fits within the limit", () => {
		expect(chunkText("short", 10)).toEqual(["short"]);
	});

	it("hard-breaks exactly at the limit when no break point exists", () => {
		expect(chunkText("aaaaaaaaaaaa", 5)).toEqual(["aaaaa", "aaaaa", "aa"]);
	});

	it("prefers word boundaries over hard breaks", () => {
		expect(chunkText("alpha beta gamma", 11)).toEqual(["alpha beta", "gamma"]);
	});

	it("prefers newlines as break points", () => {
		expect(chunkText("one two\nthree", 8)).toEqual(["one two", "three"]);
	});

	it("never breaks inside parentheses when alternatives are absent", () => {
		const chunks = chunkText("aaaa(bb bb)cc cc", 12);
		expect(chunks).toEqual(["aaaa(bb bb)c", "c cc"]);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(12);
		}
	});

	it("keeps surrogate pairs whole at hard-break boundaries", () => {
		expect(chunkText("\u{1F600}\u{1F600}\u{1F600}", 2)).toEqual([
			"\u{1F600}",
			"\u{1F600}",
			"\u{1F600}",
		]);
	});

	it("emits one whole astral pair when the limit cannot contain it", () => {
		expect(chunkText("\u{1F600}x", 1)).toEqual(["\u{1F600}", "x"]);
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
		"rejects invalid limit %s before touching the input",
		(limit) => {
			let caught: unknown;
			try {
				chunkText("irrelevant", limit);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(ElizaError);
			expect((caught as ElizaError).code).toBe("MARKDOWN_CHUNK_LIMIT_INVALID");
			expect((caught as ElizaError).message).toContain("positive safe integer");
		},
	);
});

describe("chunkByParagraph re-exported from markdown/index", () => {
	it("returns an empty array for empty input", () => {
		expect(chunkByParagraph("", 10)).toEqual([]);
	});

	it("returns one chunk for a single paragraph within the limit", () => {
		expect(chunkByParagraph("para one", 20)).toEqual(["para one"]);
	});

	it("splits only at blank-line paragraph separators", () => {
		expect(chunkByParagraph("p1\n\np2\n\np3", 100)).toEqual(["p1", "p2", "p3"]);
	});

	it("trims trailing whitespace from each paragraph", () => {
		expect(chunkByParagraph("p1   \n\np2", 100)).toEqual(["p1", "p2"]);
	});

	it("normalizes CRLF separators before paragraph detection", () => {
		expect(chunkByParagraph("p1\r\n\r\np2", 100)).toEqual(["p1", "p2"]);
	});

	it("does not split on blank lines inside fenced code blocks", () => {
		const source = "```js\n\nstill code\n```";
		expect(chunkByParagraph(source, 100)).toEqual([source]);
	});

	it("keeps an oversized paragraph intact when splitLongParagraphs is false", () => {
		expect(
			chunkByParagraph("abcdefghij", 3, { splitLongParagraphs: false }),
		).toEqual(["abcdefghij"]);
	});

	it("falls back to length-based splitting for oversized paragraphs by default", () => {
		expect(chunkByParagraph("abcdefghij", 3)).toEqual([
			"abc",
			"def",
			"ghi",
			"j",
		]);
	});
});

describe("chunkMarkdownText re-exported from markdown/index", () => {
	it("returns an empty array for empty input", () => {
		expect(chunkMarkdownText("", 10)).toEqual([]);
	});

	it("passes short text through as a single chunk", () => {
		expect(chunkMarkdownText("hi", 10)).toEqual(["hi"]);
	});

	it("splits plain text at whitespace like chunkText", () => {
		expect(chunkMarkdownText("aaa bbb ccc", 4)).toEqual(["aaa", "bbb", "ccc"]);
	});

	it("rejects invalid limits identically to the other chunkers", () => {
		let caught: unknown;
		try {
			chunkMarkdownText("text", 0);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ElizaError);
		expect((caught as ElizaError).code).toBe("MARKDOWN_CHUNK_LIMIT_INVALID");
	});

	it("closes and reopens a fence split across chunks while capping lengths", () => {
		const source = `intro line\n\`\`\`js\n${"A".repeat(30)}\n${"B".repeat(10)}\n\`\`\`\ntail`;
		const chunks = chunkMarkdownText(source, 24);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0]).toBe("intro line");
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(24);
		}
		const midChunks = chunks.slice(1, -1);
		expect(midChunks.length).toBeGreaterThan(0);
		for (const chunk of midChunks) {
			expect(chunk.startsWith("```js")).toBe(true);
			const lastMeaningfulLine = chunk
				.split("\n")
				.filter((line) => line.length > 0)
				.at(-1);
			expect(lastMeaningfulLine).toBe("```");
		}
		expect(chunks.at(-1)).toBe("tail");
	});
});

describe("fence helpers re-exported from markdown/index", () => {
	it("parses no spans for text without fences", () => {
		expect(parseFenceSpans("no fences here")).toEqual([]);
	});

	it("records a closed backtick fence with its open line and marker", () => {
		expect(parseFenceSpans("```js\ncode()\n```")).toEqual([
			{
				start: 0,
				end: 16,
				openLine: "```js",
				marker: "```",
				indent: "",
			},
		]);
	});

	it("supports tilde markers independently of backticks", () => {
		const spans = parseFenceSpans("~~~\ndata\n~~~");
		expect(spans).toHaveLength(1);
		expect(spans[0].marker).toBe("~~~");
	});

	it("treats an info-suffixed line inside an open fence as content", () => {
		const spans = parseFenceSpans("```\ncode\n```js\nmore\n```\n");
		expect(spans).toHaveLength(1);
		expect(spans[0].end).toBe(23);
	});

	it("extends an unclosed fence to the end of the buffer", () => {
		const source = "```js\nnever closed";
		const spans = parseFenceSpans(source);
		expect(spans).toEqual([
			{
				start: 0,
				end: source.length,
				openLine: "```js",
				marker: "```",
				indent: "",
			},
		]);
	});

	it("captures up to three spaces of fence indentation", () => {
		const spans = parseFenceSpans("  ```\nx\n  ```");
		expect(spans).toHaveLength(1);
		expect(spans[0].indent).toBe("  ");
	});

	it("locates containing fences with exclusive start/end boundaries", () => {
		const spans = parseFenceSpans("```js\ncode()\n```");
		expect(findFenceSpanAt(spans, 0)).toBeUndefined();
		expect(findFenceSpanAt(spans, 8)).toBe(spans[0]);
		expect(findFenceSpanAt(spans, 16)).toBeUndefined();
		expect(findFenceSpanAt([], 3)).toBeUndefined();
	});

	it("reports safe breaks outside fences and unsafe breaks inside them", () => {
		const spans = parseFenceSpans("```js\ncode()\n```");
		expect(isSafeFenceBreak(spans, 0)).toBe(true);
		expect(isSafeFenceBreak(spans, 8)).toBe(false);
		expect(isSafeFenceBreak(spans, 16)).toBe(true);
		expect(isSafeFenceBreak([], 4)).toBe(true);
	});
});

describe("inline code helpers re-exported from markdown/index", () => {
	it("creates a fresh closed inline-code state", () => {
		expect(createInlineCodeState()).toEqual({ open: false, ticks: 0 });
	});

	it("indexes simple inline code spans between single backticks", () => {
		const index = buildCodeSpanIndex("a `b` c");
		expect(index.isInside(1)).toBe(false);
		expect(index.isInside(2)).toBe(true);
		expect(index.isInside(4)).toBe(true);
		expect(index.isInside(5)).toBe(false);
		expect(index.inlineState).toEqual({ open: false, ticks: 0 });
	});

	it("counts fenced code regions as inside code and ignores ticks within them", () => {
		const index = buildCodeSpanIndex("```\nfenced `\n```");
		expect(index.isInside(7)).toBe(true);
		expect(index.isInside(16)).toBe(false);
		expect(index.inlineState).toEqual({ open: false, ticks: 0 });
	});

	it("requires matching tick counts to close an inline span", () => {
		const index = buildCodeSpanIndex("``a `b`` c");
		expect(index.isInside(0)).toBe(true);
		expect(index.isInside(5)).toBe(true);
		expect(index.isInside(9)).toBe(false);
		expect(index.inlineState).toEqual({ open: false, ticks: 0 });
	});

	it("carries an open inline span across streamed chunks via returned state", () => {
		const first = buildCodeSpanIndex("`ab");
		expect(first.inlineState).toEqual({ open: true, ticks: 1 });
		expect(first.isInside(0)).toBe(true);

		const second = buildCodeSpanIndex("cd`", first.inlineState);
		expect(second.inlineState).toEqual({ open: false, ticks: 0 });
		expect(second.isInside(2)).toBe(true);
		expect(second.isInside(3)).toBe(false);
	});
});

describe("parseFrontmatterBlock re-exported from markdown/index", () => {
	it("returns nothing for content without frontmatter delimiters", () => {
		expect(parseFrontmatterBlock("plain body only")).toEqual({});
	});

	it("returns nothing when the closing delimiter never arrives", () => {
		expect(parseFrontmatterBlock("---\nname: x\nno closer")).toEqual({});
	});

	it("coerces YAML scalar values to strings", () => {
		expect(
			parseFrontmatterBlock(
				"---\nname: Eliza\npriority: 42\nenabled: true\n---\nbody text",
			),
		).toEqual({ name: "Eliza", priority: "42", enabled: "true" });
	});

	it("strips surrounding quotes from values", () => {
		expect(parseFrontmatterBlock('---\nname: "Quoted Name"\n---')).toEqual({
			name: "Quoted Name",
		});
	});

	it("falls back to the line parser when YAML parsing fails", () => {
		expect(parseFrontmatterBlock("---\nkey: value: colon trap\n---")).toEqual({
			key: "value: colon trap",
		});
	});

	it("prefers JSON-like line-parsed values over their YAML coercion on merge", () => {
		expect(parseFrontmatterBlock("---\nopts: {a: 1}\n---")).toEqual({
			opts: "{a: 1}",
		});
	});

	it("normalizes CRLF line endings before parsing", () => {
		expect(parseFrontmatterBlock("---\r\nname: X\r\n---\r\nbody")).toEqual({
			name: "X",
		});
	});
});

describe("markdownToIR and markdownToIRWithMeta re-exported from markdown/index", () => {
	it("maps bold, italic, spoiler, and heading styling through options", () => {
		expect(markdownToIR("**bold** and *it*").styles).toEqual([
			{ start: 0, end: 4, style: "bold" },
			{ start: 9, end: 11, style: "italic" },
		]);
		expect(markdownToIR("||hidden||", { enableSpoilers: true }).styles).toEqual(
			[{ start: 0, end: 6, style: "spoiler" }],
		);
		expect(markdownToIR("# T", { headingStyle: "bold" }).styles).toEqual([
			{ start: 0, end: 1, style: "bold" },
		]);
	});

	it("extracts explicit links with exact label offsets", () => {
		expect(markdownToIR("[Eliza](https://eliza.how)")).toEqual({
			text: "Eliza",
			styles: [],
			links: [{ start: 0, end: 5, href: "https://eliza.how" }],
		});
	});

	it("emits fenced code as code_block-styled text ending in a newline", () => {
		expect(markdownToIR("```\nz\n```")).toEqual({
			text: "z\n",
			styles: [{ start: 0, end: 2, style: "code_block" }],
			links: [],
		});
	});

	it("ignores pipe tables by default and reports them via hasTables metadata", () => {
		const table = "| H1 | H2 |\n| --- | --- |\n| a | b |";
		const off = markdownToIRWithMeta(table);
		expect(off.hasTables).toBe(false);
		const bullets = markdownToIRWithMeta(table, { tableMode: "bullets" });
		expect(bullets.hasTables).toBe(true);
		expect(bullets.ir.text).toBe("a\n• H2: b");
	});
});

describe("chunkMarkdownIR re-exported from markdown/index", () => {
	it("rejects limits that cannot guarantee forward progress", () => {
		let caught: unknown;
		try {
			chunkMarkdownIR({ text: "abc", styles: [], links: [] }, 0);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ElizaError);
		expect((caught as ElizaError).code).toBe("MARKDOWN_CHUNK_LIMIT_INVALID");
	});

	it("returns an empty array for empty IR text", () => {
		expect(chunkMarkdownIR({ text: "", styles: [], links: [] }, 5)).toEqual([]);
	});

	it("returns the IR unchanged when it fits within the limit", () => {
		const ir = {
			text: "abc",
			styles: [{ start: 0, end: 3, style: "bold" as const }],
			links: [],
		};
		expect(chunkMarkdownIR(ir, 10)).toEqual([ir]);
	});

	it("relocates styles and links into their chunk-local offsets", () => {
		const ir = {
			text: "alpha beta gamma delta",
			styles: [{ start: 11, end: 16, style: "bold" as const }],
			links: [{ start: 17, end: 22, href: "https://x.test" }],
		};
		expect(chunkMarkdownIR(ir, 6)).toEqual([
			{ text: "alpha", styles: [], links: [] },
			{ text: "beta", styles: [], links: [] },
			{
				text: "gamma",
				styles: [{ start: 0, end: 5, style: "bold" }],
				links: [],
			},
			{
				text: "delta",
				styles: [],
				links: [{ start: 0, end: 5, href: "https://x.test" }],
			},
		]);
	});
});
