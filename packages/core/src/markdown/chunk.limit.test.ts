/**
 * Public Markdown chunkers reject invalid resource limits before fast paths
 * and preserve forward progress and UTF-16 integrity for valid tiny limits.
 */

import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors.ts";
import { MARKDOWN_CHUNK_LIMIT_INVALID } from "./chunk.ts";
import {
	chunkByParagraph,
	chunkMarkdownIR,
	chunkMarkdownText,
	chunkText,
	type MarkdownIR,
} from "./index.ts";

const CHUNKERS = [
	{
		name: "chunkText",
		run: (text: string, limit: number) => chunkText(text, limit),
	},
	{
		name: "chunkMarkdownText",
		run: (text: string, limit: number) => chunkMarkdownText(text, limit),
	},
	{
		name: "chunkByParagraph",
		run: (text: string, limit: number) => chunkByParagraph(text, limit),
	},
	{
		name: "chunkMarkdownIR",
		run: (text: string, limit: number) =>
			chunkMarkdownIR({ text, styles: [], links: [] }, limit),
	},
] as const;

const INVALID_LIMITS = [
	0,
	-1,
	0.5,
	1.5,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	Number.MAX_SAFE_INTEGER + 1,
] as const;

describe("Markdown chunk limit validation", () => {
	for (const chunker of CHUNKERS) {
		it(`${chunker.name} rejects every invalid limit before empty and within-limit fast paths`, () => {
			for (const text of ["", "short"]) {
				for (const limit of INVALID_LIMITS) {
					let thrown: unknown;
					try {
						chunker.run(text, limit);
					} catch (error) {
						thrown = error;
					}
					expect(thrown).toBeInstanceOf(ElizaError);
					expect((thrown as ElizaError).code).toBe(
						MARKDOWN_CHUNK_LIMIT_INVALID,
					);
					expect(
						JSON.stringify((thrown as ElizaError).context).length,
					).toBeLessThan(80);
				}
			}
		});
	}

	it("preserves reconstruction, progress, and astral scalars at limits 1 and 2", () => {
		const input = "😀x😀y";
		for (const limit of [1, 2]) {
			for (const chunker of [chunkText, chunkMarkdownText]) {
				const chunks = chunker(input, limit);
				expect(chunks.length).toBeGreaterThan(0);
				expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
				expect(chunks.join("")).toBe(input);
				for (const chunk of chunks) {
					expect(isWellFormed(chunk)).toBe(true);
					expect(chunk.length).toBeLessThanOrEqual(limit === 1 ? 2 : limit);
				}
			}
		}
	});

	it("keeps the public IR and fenced-markdown paths progressing at tiny limits", () => {
		const ir: MarkdownIR = {
			text: "😀abc",
			styles: [{ start: 0, end: 5, style: "bold" }],
			links: [],
		};
		const irChunks = chunkMarkdownIR(ir, 1);
		expect(irChunks.map((chunk) => chunk.text).join("")).toBe(ir.text);
		expect(irChunks.every((chunk) => chunk.text.length > 0)).toBe(true);

		const fenced = chunkMarkdownText("```\n😀abc\n```", 1);
		expect(fenced.length).toBeGreaterThan(0);
		expect(fenced.every((chunk) => chunk.length > 0)).toBe(true);
		expect(fenced.every(isWellFormed)).toBe(true);
	});
});

function isWellFormed(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				return false;
			}
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}
