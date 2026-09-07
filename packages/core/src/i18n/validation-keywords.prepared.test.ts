/**
 * Equivalence of the prepared keyword matcher with the per-pair predicate it
 * replaces on the action-retrieval hot path: identical match sets over ASCII,
 * non-ASCII, punctuation, multi-word, duplicate, and empty inputs. Pure
 * functions; deterministic fixtures.
 */
import { describe, expect, it } from "vitest";
import {
	collectKeywordTermMatches,
	collectPreparedKeywordTermMatches,
	prepareKeywordTerms,
	textIncludesKeywordTerm,
} from "./validation-keywords";

function legacyMatches(
	texts: readonly string[],
	terms: readonly string[],
): Set<string> {
	const matches = new Set<string>();
	for (const text of texts) {
		for (const term of terms) {
			if (textIncludesKeywordTerm(text, term)) matches.add(term);
		}
	}
	return matches;
}

const TERMS = [
	"calendar",
	"calendar event",
	"add to calendar",
	"delete",
	"delete it",
	"gym",
	"Gym Session",
	"tuesday",
	"c'est",
	"café",
	"日程",
	"to-do",
	"todo",
	"Note+",
	"(notes)",
	"",
	"   ",
	"calendar",
	"CALENDAR",
	"what's on",
	"weather report",
];

const TEXTS = [
	"add gym session tuesday at 7am to my calendar",
	"delete the Gym session on tuesday at 7am from my calendar",
	"yes, delete it",
	"whats on my calendar tuesday?",
	"Ｃａｌｅｎｄａｒ full-width café",
	"明日の日程を教えて",
	"what's on tonight",
	"Note+ (notes) todo to-do",
	"",
	"   ",
	"weather   report\nplease",
	"c'est la vie",
];

describe("prepared keyword matching", () => {
	it("returns the same match set as the per-pair predicate on the full fixture", () => {
		expect(
			collectPreparedKeywordTermMatches(TEXTS, prepareKeywordTerms(TERMS)),
		).toEqual(legacyMatches(TEXTS, TERMS));
		expect(collectKeywordTermMatches(TEXTS, TERMS)).toEqual(
			legacyMatches(TEXTS, TERMS),
		);
	});

	it("agrees on every single text and every single term", () => {
		for (const text of TEXTS) {
			for (const term of TERMS) {
				expect(
					collectPreparedKeywordTermMatches(
						[text],
						prepareKeywordTerms([term]),
					).has(term),
					`text=${JSON.stringify(text)} term=${JSON.stringify(term)}`,
				).toBe(textIncludesKeywordTerm(text, term));
			}
		}
	});

	it("keeps raw-term identity and collapses exact duplicates", () => {
		const prepared = prepareKeywordTerms(TERMS);
		const rawTerms = prepared.map((entry) => entry.term);
		expect(rawTerms).toContain("calendar");
		expect(rawTerms).toContain("CALENDAR");
		expect(rawTerms.filter((term) => term === "calendar")).toHaveLength(1);
		expect(new Set(rawTerms).size).toBe(rawTerms.length);
	});

	it("preserves text-first insertion order like the unprepared matcher", () => {
		const texts = ["delete the gym session", "whats on my calendar"];
		const terms = ["calendar", "gym", "delete"];
		expect([
			...collectPreparedKeywordTermMatches(texts, prepareKeywordTerms(terms)),
		]).toEqual([...collectKeywordTermMatches(texts, terms)]);
		expect([...collectKeywordTermMatches(texts, terms)]).toEqual([
			"gym",
			"delete",
			"calendar",
		]);
	});

	it("returns an empty set for empty inputs", () => {
		expect(
			collectPreparedKeywordTermMatches([], prepareKeywordTerms(TERMS)).size,
		).toBe(0);
		expect(collectPreparedKeywordTermMatches(TEXTS, []).size).toBe(0);
		expect(
			collectPreparedKeywordTermMatches(["", "  "], prepareKeywordTerms(TERMS))
				.size,
		).toBe(0);
	});
});
