/**
 * Covers the Markdown → IR converter (`markdown/ir`): text extraction with
 * style/link span offsets, inline styles and spoilers, links (explicit,
 * linkified, image alt-text), headings, blockquotes, lists, code blocks,
 * table rendering in off/bullets/code modes, `hasTables` metadata, and
 * lossless IR chunking with span slicing across boundaries.
 *
 * Harness: deterministic and fully real — markdown-it plus the pure IR
 * renderer run in-process with no mocks; every expectation records observed
 * behavior of this module.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors.ts";
import { MARKDOWN_CHUNK_LIMIT_INVALID } from "./chunk.js";
import {
	chunkMarkdownIR,
	type MarkdownIR,
	markdownToIR,
	markdownToIRWithMeta,
} from "./ir.ts";

describe("markdownToIR: text and spans", () => {
	it("passes plain text through without spans", () => {
		expect(markdownToIR("Hello world")).toEqual({
			text: "Hello world",
			styles: [],
			links: [],
		});
	});

	it("returns empty IR for empty input", () => {
		expect(markdownToIR("")).toEqual({ text: "", styles: [], links: [] });
	});

	it("maps bold, italic, strikethrough, and inline code to style spans", () => {
		expect(markdownToIR("**b**").styles).toEqual([
			{ start: 0, end: 1, style: "bold" },
		]);
		expect(markdownToIR("*i*").styles).toEqual([
			{ start: 0, end: 1, style: "italic" },
		]);
		expect(markdownToIR("~~s~~").styles).toEqual([
			{ start: 0, end: 1, style: "strikethrough" },
		]);
		expect(markdownToIR("`c`").styles).toEqual([
			{ start: 0, end: 1, style: "code" },
		]);
	});

	it("stacks bold and italic for nested emphasis", () => {
		expect(markdownToIR("***bi***")).toEqual({
			text: "bi",
			styles: [
				{ start: 0, end: 2, style: "bold" },
				{ start: 0, end: 2, style: "italic" },
			],
			links: [],
		});
	});

	it("keeps soft line breaks as newlines", () => {
		expect(markdownToIR("a\nb").text).toBe("a\nb");
	});

	it("separates paragraphs with a blank line and trims the tail", () => {
		expect(markdownToIR("first\n\nsecond").text).toBe("first\n\nsecond");
	});

	it("renders horizontal rules as bare newlines between paragraphs", () => {
		expect(markdownToIR("before\n\n---\n\nafter").text).toBe(
			"before\n\n\nafter",
		);
	});

	it("emits raw HTML as literal text when HTML is disabled", () => {
		expect(markdownToIR("<b>x</b>").text).toBe("<b>x</b>");
	});
});

describe("markdownToIR: spoilers", () => {
	it("keeps ||markers|| literal when spoilers are disabled", () => {
		expect(markdownToIR("||secret||")).toEqual({
			text: "||secret||",
			styles: [],
			links: [],
		});
	});

	it("wraps spoiler content when enabled", () => {
		expect(markdownToIR("||secret||", { enableSpoilers: true })).toEqual({
			text: "secret",
			styles: [{ start: 0, end: 6, style: "spoiler" }],
			links: [],
		});
	});

	it("merges adjacent spoiler spans into one", () => {
		expect(markdownToIR("||a||||b||", { enableSpoilers: true }).styles).toEqual(
			[{ start: 0, end: 2, style: "spoiler" }],
		);
	});
});

describe("markdownToIR: links", () => {
	it("records explicit links with label offsets", () => {
		expect(markdownToIR("[label](https://x.com)")).toEqual({
			text: "label",
			styles: [],
			links: [{ start: 0, end: 5, href: "https://x.com" }],
		});
	});

	it("linkifies bare URLs by default at their exact offsets", () => {
		const ir = markdownToIR("see https://eliza.how now");
		expect(ir.links).toEqual([
			{ start: 4, end: 21, href: "https://eliza.how" },
		]);
		expect(ir.text.slice(4, 21)).toBe("https://eliza.how");
	});

	it("skips linkification when linkify is false", () => {
		expect(
			markdownToIR("see https://eliza.how now", { linkify: false }).links,
		).toEqual([]);
	});

	it("still resolves angle-bracket autolinks with autolink option disabled", () => {
		const ir = markdownToIR("<https://x.com>", { autolink: false });
		expect(ir.links).toEqual([{ start: 1, end: 14, href: "https://x.com" }]);
		expect(ir.text).toBe("<https://x.com>");
	});

	it("drops links whose label is empty after trimming", () => {
		expect(markdownToIR("[  ](https://x.com)").links).toEqual([]);
	});

	it("renders images as their alt text without creating a link", () => {
		expect(markdownToIR("![alt pic](https://img.example/i.png)")).toEqual({
			text: "alt pic",
			styles: [],
			links: [],
		});
	});

	it("combines styles and link spans on the same offsets", () => {
		expect(markdownToIR("**[lbl](https://x.com)**")).toEqual({
			text: "lbl",
			styles: [{ start: 0, end: 3, style: "bold" }],
			links: [{ start: 0, end: 3, href: "https://x.com" }],
		});
	});
});

describe("markdownToIR: structure", () => {
	it("renders headings as plain text by default", () => {
		expect(markdownToIR("# Title")).toEqual({
			text: "Title",
			styles: [],
			links: [],
		});
	});

	it("bolds heading text when headingStyle is bold", () => {
		expect(markdownToIR("# Title", { headingStyle: "bold" }).styles).toEqual([
			{ start: 0, end: 5, style: "bold" },
		]);
	});

	it("prefixes blockquotes with the configured marker", () => {
		expect(markdownToIR("> quoted", { blockquotePrefix: "> " }).text).toBe(
			"> quoted",
		);
	});

	it("numbers ordered lists from their start attribute", () => {
		expect(markdownToIR("3. a\n4. b").text).toBe("3. a\n4. b");
	});

	it("indents nested bullet items under their parent", () => {
		expect(markdownToIR("- a\n  - b").text).toBe("• a  • b");
	});

	it("emits fenced code as code_block text ending with a newline", () => {
		expect(markdownToIR("```\nlet x = 1;\n```")).toEqual({
			text: "let x = 1;\n",
			styles: [{ start: 0, end: 11, style: "code_block" }],
			links: [],
		});
	});
});

describe("markdownToIR: tables", () => {
	const TABLE = "| H1 | H2 |\n| --- | --- |\n| a | b |";

	it("ignores pipe tables entirely in the default off mode", () => {
		const meta = markdownToIRWithMeta(TABLE);
		expect(meta.hasTables).toBe(false);
		expect(meta.ir.text).toBe("| H1 | H2 |\n| --- | --- |\n| a | b |");
		expect(meta.ir.styles).toEqual([]);
	});

	it("renders tables as labeled bullets using the first column as label", () => {
		const meta = markdownToIRWithMeta(TABLE, { tableMode: "bullets" });
		expect(meta.hasTables).toBe(true);
		expect(meta.ir).toEqual({
			text: "a\n• H2: b",
			styles: [{ start: 0, end: 1, style: "bold" }],
			links: [],
		});
	});

	it("renders tables as aligned pipe grids wrapped in a code block", () => {
		const meta = markdownToIRWithMeta(TABLE, { tableMode: "code" });
		expect(meta.hasTables).toBe(true);
		expect(meta.ir.text).toBe("| H1 | H2 |\n| --- | --- |\n| a  | b  |\n");
		expect(meta.ir.styles).toEqual([
			{ start: 0, end: 38, style: "code_block" },
		]);
	});
});

describe("chunkMarkdownIR", () => {
	const sample: MarkdownIR = {
		text: "aaa bbb ccc",
		styles: [{ start: 4, end: 7, style: "bold" }],
		links: [{ start: 8, end: 11, href: "h" }],
	};

	it("rejects limits that cannot guarantee forward progress", () => {
		let caught: unknown;
		try {
			chunkMarkdownIR(sample, 0);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ElizaError);
		expect((caught as ElizaError).code).toBe(MARKDOWN_CHUNK_LIMIT_INVALID);
	});

	it("returns an empty array for empty IR", () => {
		expect(chunkMarkdownIR({ text: "", styles: [], links: [] }, 5)).toEqual([]);
	});

	it("returns the IR unchanged when it fits within the limit", () => {
		expect(chunkMarkdownIR(sample, 100)).toEqual([sample]);
	});

	it("splits at word boundaries and relocates spans into their chunks", () => {
		expect(chunkMarkdownIR(sample, 4)).toEqual([
			{ text: "aaa", styles: [], links: [] },
			{ text: "bbb", styles: [{ start: 0, end: 3, style: "bold" }], links: [] },
			{
				text: "ccc",
				styles: [],
				links: [{ start: 0, end: 3, href: "h" }],
			},
		]);
	});

	it("clips spans that cross a chunk boundary to each side", () => {
		const wide: MarkdownIR = {
			text: "abcdefghij",
			styles: [{ start: 2, end: 8, style: "italic" }],
			links: [{ start: 0, end: 10, href: "u" }],
		};
		expect(chunkMarkdownIR(wide, 5)).toEqual([
			{
				text: "abcde",
				styles: [{ start: 2, end: 5, style: "italic" }],
				links: [{ start: 0, end: 5, href: "u" }],
			},
			{
				text: "fghij",
				styles: [{ start: 0, end: 3, style: "italic" }],
				links: [{ start: 0, end: 5, href: "u" }],
			},
		]);
	});

	it("preserves all non-whitespace content across chunks (lossless reassembly)", () => {
		const long = markdownToIR(
			"# Report\n\nSome **important** text with [a link](https://eliza.how) inside.\n\n- one\n- two\n- three",
		);
		const chunks = chunkMarkdownIR(long, 24);
		expect(chunks.length).toBeGreaterThan(1);
		const reassembled = chunks
			.map((chunk) => chunk.text)
			.join(" ")
			.replace(/\s+/g, "");
		expect(reassembled).toBe(long.text.replace(/\s+/g, ""));
		for (const chunk of chunks) {
			for (const span of chunk.styles) {
				expect(chunk.text.slice(span.start, span.end)).toMatch(/\S/);
			}
			for (const link of chunk.links) {
				expect(link.href).toMatch(/^https?:\/\//);
			}
		}
	});
});
