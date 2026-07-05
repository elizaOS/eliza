/**
 * In-memory message search ranker parity checks for adapters without SQL.
 * These tests pin the same typo/substring behavior the SQL adapter exposes via
 * full-text search plus pg_trgm so fallback stores do not silently regress.
 */

import { describe, expect, it } from "vitest";
import { rankMessageSearch } from "./search.ts";

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
