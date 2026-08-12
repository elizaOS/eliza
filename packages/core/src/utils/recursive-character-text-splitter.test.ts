/**
 * Deterministic unit coverage for {@link RecursiveCharacterTextSplitter}. The
 * splitter is pure — no clock, no I/O — so every case is an exact
 * input/output assertion.
 *
 * The invariants worth guarding are the ones a refactor can silently break:
 * separators are consumed coarsest-first and only fall through when the current
 * one is absent; a separator is embedded in a `RegExp` when `keepSeparator` is
 * set, so one containing regex metacharacters must still split literally; no
 * chunk may exceed `chunkSize` while the text is still divisible; and merging
 * must neither drop nor duplicate content beyond the requested overlap.
 */

import { describe, expect, it } from "vitest";
import { RecursiveCharacterTextSplitter } from "./recursive-character-text-splitter";

/** Space-separated atoms, each far shorter than any chunkSize used below. */
const WORDS = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");

describe("constructor", () => {
	it("rejects an overlap that is not smaller than the chunk", () => {
		expect(
			() =>
				new RecursiveCharacterTextSplitter({ chunkSize: 10, chunkOverlap: 10 }),
		).toThrow("Cannot have chunkOverlap >= chunkSize");
		expect(
			() =>
				new RecursiveCharacterTextSplitter({ chunkSize: 10, chunkOverlap: 20 }),
		).toThrow("Cannot have chunkOverlap >= chunkSize");
	});

	it("accepts an overlap smaller than the chunk", () => {
		expect(
			() =>
				new RecursiveCharacterTextSplitter({ chunkSize: 10, chunkOverlap: 9 }),
		).not.toThrow();
	});
});

describe("splitText", () => {
	it("returns the whole text when it already fits", async () => {
		const splitter = new RecursiveCharacterTextSplitter({
			chunkSize: 100,
			chunkOverlap: 0,
		});
		expect(await splitter.splitText("hello world")).toEqual(["hello world"]);
	});

	it("yields nothing for input with no retainable content", async () => {
		const splitter = new RecursiveCharacterTextSplitter({
			chunkSize: 100,
			chunkOverlap: 0,
		});
		expect(await splitter.splitText("")).toEqual([]);
		expect(await splitter.splitText("   \n\n  ")).toEqual([]);
	});

	it("merges pieces up to chunkSize instead of emitting one per separator", async () => {
		const splitter = new RecursiveCharacterTextSplitter({
			chunkSize: 20,
			chunkOverlap: 0,
		});
		expect(await splitter.splitText("aaaa\n\nbbbb\n\ncccc")).toEqual([
			"aaaa\n\nbbbb\n\ncccc",
		]);
	});

	it("splits on the paragraph separator once the merge no longer fits", async () => {
		const splitter = new RecursiveCharacterTextSplitter({
			chunkSize: 6,
			chunkOverlap: 0,
		});
		expect(await splitter.splitText("aaaa\n\nbbbb\n\ncccc")).toEqual([
			"aaaa",
			"bbbb",
			"cccc",
		]);
	});

	it("trims the retained separator off a chunk boundary", async () => {
		// keepSeparator splits on a lookahead, so a piece carries its leading
		// separator; joinDocs trims the merged result, so the boundary text does
		// not surface in the output either way.
		const kept = new RecursiveCharacterTextSplitter({
			chunkSize: 6,
			chunkOverlap: 0,
		});
		const dropped = new RecursiveCharacterTextSplitter({
			chunkSize: 6,
			chunkOverlap: 0,
			keepSeparator: false,
		});
		const text = "aaaa\n\nbbbb\n\ncccc";
		expect(await kept.splitText(text)).toEqual(await dropped.splitText(text));
	});

	it("falls through separators coarsest to finest", async () => {
		// The paragraph break wins where present; the two halves are then split on
		// the line break rather than on spaces.
		const splitter = new RecursiveCharacterTextSplitter({
			chunkSize: 9,
			chunkOverlap: 0,
		});
		expect(await splitter.splitText("aa bb\ncc dd\n\nee ff")).toEqual([
			"aa bb",
			"cc dd",
			"ee ff",
		]);
	});

	it("carries chunkOverlap from the end of a chunk into the next", async () => {
		const splitter = new RecursiveCharacterTextSplitter({
			chunkSize: 10,
			chunkOverlap: 5,
			separators: [" ", ""],
		});
		expect(await splitter.splitText("aa bb cc dd ee ff")).toEqual([
			"aa bb cc",
			"cc dd ee",
			"ee ff",
		]);
	});

	it("emits an indivisible piece whole rather than truncating it", async () => {
		// No separator in the list matches, so the piece cannot be reduced; the
		// splitter is documented to emit it (and warn) instead of cutting content.
		const splitter = new RecursiveCharacterTextSplitter({
			chunkSize: 5,
			chunkOverlap: 0,
			separators: ["\n\n"],
		});
		expect(await splitter.splitText("abcdefghijkl")).toEqual(["abcdefghijkl"]);
	});

	it("honours an async lengthFunction instead of raw character count", async () => {
		const splitter = new RecursiveCharacterTextSplitter({
			chunkSize: 10,
			chunkOverlap: 0,
			separators: [" ", ""],
			lengthFunction: async (text) => text.length * 2,
		});
		// Every atom counts double, so "aa bb" (10 by that measure) fills a chunk.
		expect(await splitter.splitText("aa bb cc")).toEqual(["aa bb", "cc"]);
	});

	describe("separators containing regex metacharacters", () => {
		// keepSeparator embeds the separator in a lookahead RegExp, so an
		// unescaped metacharacter would change what the pattern matches.
		it.each([
			["|", "aaa|bbb|ccc"],
			[".", "aaa.bbb.ccc"],
			["+", "aaa+bbb+ccc"],
			["(", "aaa(bbb(ccc"],
			["$", "aaa$bbb$ccc"],
		])("splits literally on %j", async (separator, text) => {
			const splitter = new RecursiveCharacterTextSplitter({
				chunkSize: 8,
				chunkOverlap: 0,
				separators: [separator, ""],
			});
			expect(await splitter.splitText(text)).toEqual([
				`aaa${separator}bbb`,
				`${separator}ccc`,
			]);
		});
	});

	describe("invariants across chunk sizes", () => {
		const sizes = [5, 7, 10, 13, 20, 33];

		it.each(sizes)(
			"keeps every chunk within chunkSize %i",
			async (chunkSize) => {
				for (const chunkOverlap of [0, Math.floor(chunkSize / 3)]) {
					const splitter = new RecursiveCharacterTextSplitter({
						chunkSize,
						chunkOverlap,
						separators: [" ", ""],
					});
					for (const chunk of await splitter.splitText(WORDS)) {
						expect(chunk.length).toBeLessThanOrEqual(chunkSize);
					}
				}
			},
		);

		it.each(sizes)(
			"loses no content at chunkSize %i with no overlap",
			async (chunkSize) => {
				const splitter = new RecursiveCharacterTextSplitter({
					chunkSize,
					chunkOverlap: 0,
					separators: [" ", ""],
				});
				expect((await splitter.splitText(WORDS)).join(" ")).toBe(WORDS);
			},
		);
	});
});
