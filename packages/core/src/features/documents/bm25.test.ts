/**
 * Unit tests for BM25 document ranking, term tokenization, and score normalization.
 */

import { describe, expect, it } from "vitest";
import {
	type Bm25Document,
	bm25Scores,
	normalizeBm25Scores,
	tokenize,
} from "./bm25.js";

describe("bm25", () => {
	it("tokenizes text into lowercase alphanumeric tokens without punctuation", () => {
		expect(tokenize("Hello, World! 123")).toEqual(["hello", "world", "123"]);
		expect(tokenize("   special-case: text_with_symbols...  ")).toEqual([
			"special",
			"case",
			"text",
			"with",
			"symbols",
		]);
	});

	it("calculates BM25 relevance scores for document corpus", () => {
		const docs: Bm25Document[] = [
			{
				id: "doc1",
				text: "The quick brown fox jumps over the lazy dog",
			},
			{
				id: "doc2",
				text: "Artificial intelligence and machine learning algorithms",
			},
			{
				id: "doc3",
				text: "Brown foxes and wild dogs in nature",
			},
		];

		const scores = bm25Scores("brown fox", docs);
		expect(scores).toHaveLength(3);

		const doc1Score = scores.find((s) => s.id === "doc1")?.score ?? 0;
		const doc2Score = scores.find((s) => s.id === "doc2")?.score ?? 0;
		const doc3Score = scores.find((s) => s.id === "doc3")?.score ?? 0;

		expect(doc1Score).toBeGreaterThan(0);
		expect(doc2Score).toBe(0); // no matching terms
		expect(doc1Score).toBeGreaterThan(doc2Score);
		expect(doc3Score).toBeGreaterThan(doc2Score);
	});

	it("handles empty query or document set gracefully", () => {
		expect(bm25Scores("", [])).toEqual([]);

		const docs: Bm25Document[] = [{ id: "d1", text: "Some text" }];
		expect(bm25Scores("", docs)).toEqual([{ id: "d1", score: 0 }]);
		expect(bm25Scores("   ", docs)).toEqual([{ id: "d1", score: 0 }]);
	});

	it("normalizes BM25 scores to [0, 1] range", () => {
		const scores = [
			{ id: "a", score: 10 },
			{ id: "b", score: 5 },
			{ id: "c", score: 0 },
		];

		const normalized = normalizeBm25Scores(scores);
		expect(normalized).toEqual([
			{ id: "a", score: 1 },
			{ id: "b", score: 0.5 },
			{ id: "c", score: 0 },
		]);

		// All zero array unchanged
		const allZero = [{ id: "x", score: 0 }];
		expect(normalizeBm25Scores(allZero)).toEqual([{ id: "x", score: 0 }]);
	});
});
