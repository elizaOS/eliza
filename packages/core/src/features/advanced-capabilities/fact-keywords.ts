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
		memory.content?.text ?? "",
		metadata.category ?? "",
		keywords.join(" "),
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
