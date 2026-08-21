/**
 * In-memory message search ranker parity checks for adapters without SQL.
 * These tests pin the same typo/substring behavior the SQL adapter exposes via
 * full-text search plus pg_trgm so fallback stores do not silently regress.
 */

import { describe, expect, it } from "vitest";
import { BM25, rankMessageSearch } from "./search.ts";

describe("rankMessageSearch", () => {
	it("matches a typo by trigram similarity, not only exact substrings", () => {
		const hits = rankMessageSearch(
			[
				{
					id: "a",
					createdAt: 1,
					content: { text: "how do I edit the configuration file" },
				},
				{
					id: "b",
					createdAt: 2,
					content: { text: "unrelated deployment notes" },
				},
			],
			"configuraton",
		);

		expect(hits.map((hit) => hit.item.id)).toEqual(["a"]);
		expect(hits[0].ftsRank).toBe(0);
		expect(hits[0].trigramSimilarity).toBeGreaterThanOrEqual(0.45);
	});

	it("requires every multi-term query token to match before using typo recall", () => {
		const items = [
			{
				id: "a",
				createdAt: 1,
				content: { text: "how do I edit the configuration file" },
			},
			{
				id: "b",
				createdAt: 2,
				content: { text: "deployment notes without the requested setup token" },
			},
		];

		expect(
			rankMessageSearch(items, "configuraton file").map((hit) => hit.item.id),
		).toEqual(["a"]);
		expect(rankMessageSearch(items, "configuraton deployment")).toEqual([]);
	});

	it("does not admit unrelated text through the trigram branch", () => {
		const hits = rankMessageSearch(
			[
				{
					id: "a",
					content: { text: "how do I edit the configuration file" },
				},
			],
			"zzzzzzzz",
		);

		expect(hits).toEqual([]);
	});
});

describe("BM25.search result ordering", () => {
	// One "signal" occurrence per short doc scores higher than one occurrence
	// diluted across a longer doc, so relevance order differs from index order.
	const docs = [
		{ body: "signal buried in a much longer document about other topics" },
		{ body: "irrelevant filler text" },
		{ body: "signal signal signal" },
	];

	it("returns descending scores even when fewer matches exist than topK", () => {
		const bm25 = new BM25(docs);
		const results = bm25.search("signal", 10);

		expect(results.map((r) => r.index)).toEqual([2, 0]);
		expect(results[0].score).toBeGreaterThan(results[1].score);
	});

	it("keeps the bounded top-K path intact when the buffer fills", () => {
		const bm25 = new BM25(docs);
		const results = bm25.search("signal", 2);

		expect(results).toHaveLength(2);
		expect(results.map((r) => r.index)).toEqual([2, 0]);
	});

	it("breaks score ties in ascending document order on the partial path", () => {
		const twins = [
			{ body: "unique filler alpha" },
			{ body: "echo chamber" },
			{ body: "echo chamber" },
		];
		const bm25 = new BM25(twins);
		const results = bm25.search("echo", 10);

		expect(results.map((r) => r.index)).toEqual([1, 2]);
		expect(results[0].score).toBe(results[1].score);
	});
});

describe("BM25 empty string fields", () => {
	// Attachment-only memories carry `content.text === ""` into rerankMemories;
	// the tokenizer rejects falsy input, so empty fields must index as
	// zero-length docs instead of aborting the whole index build.
	const docs = [
		{ title: "11111111-1111-4111-8111-111111111111", content: "" },
		{ title: "22222222-2222-4222-8222-222222222222", content: "hello world" },
	];

	it("indexes documents containing empty string fields without throwing", () => {
		const bm25 = new BM25(docs);
		expect(bm25.search("hello", 10).map((r) => r.index)).toEqual([1]);
	});

	it("treats whitespace-only fields as zero-length documents", () => {
		const bm25 = new BM25([{ content: "   " }, { content: "signal" }]);
		expect(bm25.search("signal", 10).map((r) => r.index)).toEqual([1]);
	});

	it("accepts incremental addDocument with empty string fields", async () => {
		const bm25 = new BM25([{ content: "seed document" }]);
		await bm25.addDocument({ content: "", body: "later arrival" });
		expect(bm25.search("arrival", 10).map((r) => r.index)).toEqual([1]);
	});
});

describe("BM25 empty text at the remaining tokenize call sites", () => {
	// Indexing guards its own call sites, but search/searchPhrase tokenize
	// through the same path, so empty input reached the tokenizer unguarded.
	it("returns no hits for an empty or whitespace-only query", () => {
		const bm25 = new BM25([{ title: "a", content: "hello world" }]);

		expect(bm25.search("", 10)).toEqual([]);
		expect(bm25.search("   ", 10)).toEqual([]);
	});

	it("returns no hits for an empty phrase", () => {
		const bm25 = new BM25([{ title: "a", content: "hello world" }]);

		expect(bm25.searchPhrase("", 10)).toEqual([]);
	});

	// Two conditions have to line up before the phrase rescan reaches the
	// tokenizer with empty text: the document must already be a phrase
	// candidate, and the empty field must be iterated BEFORE the matching one,
	// since the loop stops looking once it finds the phrase. An attachment-only
	// field ahead of the title is exactly that shape.
	it("scans a matching document with an empty field without throwing", () => {
		const bm25 = new BM25([
			{ attachment: "", title: "hello world again" },
			{ attachment: "x", title: "unrelated" },
		]);

		expect(bm25.searchPhrase("hello world", 10).map((r) => r.index)).toEqual([
			0,
		]);
	});

	// BM25 normalizes by document length, so an empty field contributing any
	// nonzero length would skew every other document's relative score. Not
	// crashing is the visible bug; scoring identically is the quiet one.
	it("scores an empty field identically to an absent field", () => {
		const withEmpty = new BM25([
			{ title: "hello world", content: "" },
			{ title: "unrelated", content: "nothing here" },
		]);
		const withoutEmpty = new BM25([
			{ title: "hello world" },
			{ title: "unrelated", content: "nothing here" },
		]);

		expect(withEmpty.search("hello", 10)[0].score).toBe(
			withoutEmpty.search("hello", 10)[0].score,
		);
	});

	it("ranks a memory whose text is empty instead of throwing", () => {
		const hits = rankMessageSearch(
			[
				{ id: "empty", content: { text: "" } },
				{ id: "filled", content: { text: "query words here" } },
			],
			"query",
		);

		expect(hits.map((hit) => hit.item.id)).toEqual(["filled"]);
	});
});
