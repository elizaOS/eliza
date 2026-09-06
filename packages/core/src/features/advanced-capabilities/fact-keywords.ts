/**
 * Lexical keyword tooling behind fact retrieval in the advanced-capabilities
 * bundle. Tokenizes fact text (lowercase, strip punctuation/stopwords, split
 * hyphens, length floors), extracts and frequency-ranks keywords, and builds the
 * per-fact search text and query text used for recall. `scoreFactKeywordRelevance`
 * ranks candidate fact memories with BM25 over that search text, while
 * `factLexicalSimilarity` blends coverage (0.7) and Jaccard (0.3) into a
 * keyword-set similarity (1.0 identical, 0 disjoint) for dedupe/matching.
 */
import type { FactMetadata, Memory } from "../../types/index.ts";
import { bm25Scores, normalizeBm25Scores } from "../documents/bm25.ts";

const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"from",
	"about",
	"into",
	"onto",
	"over",
	"under",
	"then",
	"than",
	"they",
	"them",
	"their",
	"there",
	"here",
	"were",
	"was",
	"are",
	"is",
	"am",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"will",
	"would",
	"could",
	"should",
	"can",
	"may",
	"might",
	"must",
	"not",
	"but",
	"you",
	"your",
	"yours",
	"user",
	"users",
	"agent",
	"speaker",
	"person",
	"someone",
	"thing",
	"things",
	"currently",
	"really",
	"very",
	"just",
	"like",
	"want",
	"need",
	"please",
]);

const MAX_KEYWORDS = 16;

function readFactMetadata(memory: Memory): FactMetadata {
	const meta = memory.metadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
	return meta as FactMetadata;
}

function flattenValue(value: unknown, depth = 0): string[] {
	if (value == null || depth > 2) return [];
	if (typeof value === "string") return [value];
	if (typeof value === "number" || typeof value === "boolean") {
		return [String(value)];
	}
	if (Array.isArray(value)) {
		return value.flatMap((item) => flattenValue(item, depth + 1));
	}
	if (typeof value === "object") {
		return Object.entries(value as Record<string, unknown>).flatMap(
			([key, nested]) => [key, ...flattenValue(nested, depth + 1)],
		);
	}
	return [];
}

export function tokenizeFactText(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/\s+/)
		.flatMap((token) => token.split("-"))
		.map((token) => token.trim())
		.filter((token) => {
			if (!token) return false;
			if (STOPWORDS.has(token)) return false;
			if (/^\d+$/.test(token)) return token.length >= 2;
			return token.length >= 3;
		});
}

export function extractFactKeywords(...values: unknown[]): string[] {
	const terms = values.flatMap((value) =>
		flattenValue(value).flatMap(tokenizeFactText),
	);
	const stats = new Map<
		string,
		{ term: string; count: number; firstSeen: number }
	>();
	terms.forEach((term, index) => {
		const existing = stats.get(term);
		if (existing) {
			existing.count += 1;
			return;
		}
		stats.set(term, { term, count: 1, firstSeen: index });
	});
	return [...stats.values()]
		.sort((left, right) => {
			if (right.count !== left.count) return right.count - left.count;
			return left.firstSeen - right.firstSeen;
		})
		.slice(0, MAX_KEYWORDS)
		.map((entry) => entry.term);
}

export function readStoredFactKeywords(memory: Memory): string[] {
	const keywords = readFactMetadata(memory).keywords;
	if (!Array.isArray(keywords)) return [];
	return extractFactKeywords(keywords);
}

export function buildFactSearchText(memory: Memory): string {
	const metadata = readFactMetadata(memory);
	const keywords = readStoredFactKeywords(memory);
	return [
		memory.content.text ?? "",
		metadata.category ?? "",
		keywords.join(" "),
		metadata.structuredFields ?? {},
	]
		.flatMap(flattenValue)
		.join(" ");
}

export function buildFactQueryText(...values: unknown[]): string {
	return extractFactKeywords(values).join(" ");
}

export function buildFactKeywordsForStorage(...values: unknown[]): string[] {
	return extractFactKeywords(values);
}

export interface FactKeywordRelevance {
	memory: Memory;
	relevance: number;
}

export function scoreFactKeywordRelevance(
	queryText: string,
	memories: Memory[],
): FactKeywordRelevance[] {
	if (memories.length === 0) return [];
	const documents = memories.map((memory, index) => ({
		id: `fact-${index}`,
		text: buildFactSearchText(memory),
	}));
	const scores = normalizeBm25Scores(bm25Scores(queryText, documents));
	return scores.map((score, index) => ({
		memory: memories[index],
		relevance: score.score,
	}));
}

const NEGATION_PATTERN =
	/\b(?:not|no|never|none|neither|nor|without|cannot|can't|cant|won't|wont|don't|dont|doesn't|doesnt|didn't|didnt|isn't|isnt|aren't|arent|wasn't|wasnt|hasn't|hasnt|haven't|havent|wouldn't|wouldnt|shouldn't|shouldnt|couldn't|couldnt|dislikes?|disliked|hates?|hated|avoids?|avoided|stopped|quit|refuses?|refused)\b/gi;

/**
 * Markers that place a claim in the past or mark a reversal, so "used to
 * prefer X" and "prefers X" are different claims however many words they share.
 */
const TEMPORAL_SHIFT_PATTERN =
	/\b(?:used to|no longer|not anymore|anymore|any more|previously|formerly|back then|in the past|these days|nowadays|from now on|switched (?:to|from)|changed (?:to|from))\b/i;

function negationParity(text: string): number {
	const normalized = text.replace(/[\u2018\u2019]/g, "'");
	const matches = normalized.match(NEGATION_PATTERN);
	return (matches?.length ?? 0) % 2;
}

/**
 * True when the two texts cannot be the same claim: their negation parity
 * differs ("likes oat milk" vs "does not like oat milk"; "used to hate oat
 * milk" vs "does not hate oat milk", where the double negation flips back), or
 * exactly one side carries a past/reversal marker ("used to prefer" vs
 * "prefers"). Keyword similarity drops stopwords such as "not" and cannot see
 * either, so a lexical match alone is never treated as equivalence.
 */
export function factPolarityDiffers(left: string, right: string): boolean {
	if (negationParity(left) !== negationParity(right)) return true;
	return (
		TEMPORAL_SHIFT_PATTERN.test(left) !== TEMPORAL_SHIFT_PATTERN.test(right)
	);
}

// "user", "the user", the possessive "user's"/"the user's", and first-person
// "my" all name the row's own subject (live 2026-09-06: the MEMORY action stored
// "The user's favorite tea is hojicha" while Stage-1 kept "favorite tea is
// hojicha"; the guard compared them unequal and both rows persisted).
const LEADING_SUBJECT_PATTERN = /^(?:(?:the )?user(?:'s)?|my)\s+/;

/**
 * Cosmetic normalization only: case (Unicode-aware), curly quotes, whitespace,
 * one trailing sentence terminator, and a leading "user"/"the user" subject
 * reference (the subject is fixed by the row's entity binding, not by this
 * word). Every other character is kept in order — letters in any script,
 * digits, and punctuation that can carry meaning ("C++" vs "C", "A > B" vs
 * "A < B", "likes 茶" vs "likes 咖啡" all stay distinct).
 */
function normalizeClaimText(text: string): string {
	return text
		.normalize("NFC")
		.toLowerCase()
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201c\u201d]/g, '"')
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.!?。]+$/u, "")
		.trim()
		.replace(LEADING_SUBJECT_PATTERN, "");
}

/**
 * Conservative "same claim" test for destructive convergence (one row absorbs
 * another): after cosmetic normalization the two texts must be identical, word
 * for word and in order, with the same polarity. "prefers oat milk in coffee"
 * and "User prefers oat milk in coffee." are the same claim; "prefers tea over
 * coffee" / "prefers coffee over tea" (reversed), "prefers oat milk in coffee"
 * / "prefers oat milk in their coffee" (a modifier), and "previously liked oat
 * milk" / "nowadays likes oat milk" are not, and stay as separate rows —
 * a duplicate row is recoverable, a suppressed distinct fact is not. Keyword
 * similarity remains retrieval ranking only, never proof of equivalence.
 */
export function factClaimsEquivalent(left: string, right: string): boolean {
	if (factPolarityDiffers(left, right)) return false;
	const normalizedLeft = normalizeClaimText(left);
	const normalizedRight = normalizeClaimText(right);
	return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}

export function factLexicalSimilarity(
	leftValues: unknown[],
	rightValues: unknown[],
): number {
	const left = new Set(extractFactKeywords(leftValues));
	const right = new Set(extractFactKeywords(rightValues));
	if (left.size === 0 || right.size === 0) return 0;

	let intersection = 0;
	for (const term of left) {
		if (right.has(term)) intersection += 1;
	}
	if (intersection === 0) return 0;

	const union = new Set([...left, ...right]).size;
	const coverage = intersection / Math.min(left.size, right.size);
	const jaccard = intersection / union;
	return coverage * 0.7 + jaccard * 0.3;
}
