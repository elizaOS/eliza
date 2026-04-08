/**
 * BM25 index with incremental add/remove support.
 *
 * Uses the shared Tokenizer from search.ts as the primary text processor
 * (Unicode normalization, optional Porter2 stemming, configurable stopwords).
 * Falls back to a unicode-aware regex tokenizer for scripts the shared
 * Tokenizer doesn't cover (Cyrillic, Arabic, etc.).
 *
 * Scoring formula:
 *   score(q, d) = Σ IDF(qi) * (f(qi, d) * (k1 + 1)) / (f(qi, d) + k1 * (1 - b + b * |d| / avgdl))
 */

import { Tokenizer, type TokenizerOptions } from "../search.ts";

/** Common English stopwords. */
const ENGLISH_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"but",
	"by",
	"do",
	"for",
	"from",
	"had",
	"has",
	"have",
	"he",
	"her",
	"his",
	"how",
	"i",
	"if",
	"in",
	"into",
	"is",
	"it",
	"its",
	"me",
	"my",
	"no",
	"not",
	"of",
	"on",
	"or",
	"our",
	"out",
	"own",
	"she",
	"so",
	"than",
	"that",
	"the",
	"their",
	"them",
	"then",
	"there",
	"these",
	"they",
	"this",
	"to",
	"too",
	"up",
	"us",
	"very",
	"was",
	"we",
	"what",
	"when",
	"where",
	"which",
	"who",
	"whom",
	"why",
	"will",
	"with",
	"would",
	"you",
	"your",
]);

interface BM25Document {
	id: string;
	termFrequencies: Map<string, number>;
	length: number;
}

export interface BM25Result {
	id: string;
	score: number;
}

/**
 * BM25 index for text documents with incremental add/remove.
 *
 * Primary tokenization: shared Tokenizer (stemming, Unicode normalization).
 * Fallback: unicode-aware regex split for scripts the Tokenizer strips
 * (Cyrillic, Arabic, Devanagari, etc.). The fallback tokens are merged
 * with the primary tokens so all scripts are searchable.
 */
export class BM25Index {
	private documents: Map<string, BM25Document> = new Map();
	private documentFrequencies: Map<string, number> = new Map();
	private avgDocLength = 0;
	private totalTermCount = 0;
	private k1: number;
	private b: number;
	private sharedTokenizer: Tokenizer;
	private stopWords: Set<string>;

	constructor(k1 = 1.5, b = 0.75, tokenizerOptions?: TokenizerOptions) {
		this.k1 = k1;
		this.b = b;
		this.stopWords = tokenizerOptions?.stopWords ?? ENGLISH_STOPWORDS;
		this.sharedTokenizer = new Tokenizer({
			stopWords: this.stopWords,
			minLength: tokenizerOptions?.minLength ?? 2,
			stemming: tokenizerOptions?.stemming ?? false,
			...tokenizerOptions,
		});
	}

	addDocument(id: string, text: string): void {
		if (this.documents.has(id)) {
			this.removeDocument(id);
		}

		const terms = this.tokenize(text);
		const termFrequencies = new Map<string, number>();
		for (const term of terms) {
			termFrequencies.set(term, (termFrequencies.get(term) ?? 0) + 1);
		}

		this.documents.set(id, { id, termFrequencies, length: terms.length });

		for (const term of termFrequencies.keys()) {
			this.documentFrequencies.set(
				term,
				(this.documentFrequencies.get(term) ?? 0) + 1,
			);
		}

		this.totalTermCount += terms.length;
		this.recomputeAvgDocLength();
	}

	removeDocument(id: string): void {
		const doc = this.documents.get(id);
		if (!doc) return;

		for (const term of doc.termFrequencies.keys()) {
			const currentDf = this.documentFrequencies.get(term) ?? 0;
			if (currentDf <= 1) {
				this.documentFrequencies.delete(term);
			} else {
				this.documentFrequencies.set(term, currentDf - 1);
			}
		}

		this.totalTermCount -= doc.length;
		this.documents.delete(id);
		this.recomputeAvgDocLength();
	}

	search(query: string, topK?: number): BM25Result[] {
		const queryTerms = this.tokenize(query);
		if (queryTerms.length === 0 || this.documents.size === 0) return [];

		const N = this.documents.size;
		const results: BM25Result[] = [];
		for (const doc of this.documents.values()) {
			const score = this.scoreDocument(doc, queryTerms, N);
			if (score > 0) results.push({ id: doc.id, score });
		}
		return sortAndTruncate(results, topK);
	}

	searchSubset(
		query: string,
		documentIds: string[],
		topK?: number,
	): BM25Result[] {
		const queryTerms = this.tokenize(query);
		if (queryTerms.length === 0 || this.documents.size === 0) return [];

		const N = this.documents.size;
		const results: BM25Result[] = [];
		for (const id of documentIds) {
			const doc = this.documents.get(id);
			if (!doc) continue;
			const score = this.scoreDocument(doc, queryTerms, N);
			if (score > 0) results.push({ id: doc.id, score });
		}
		return sortAndTruncate(results, topK);
	}

	get size(): number {
		return this.documents.size;
	}

	has(id: string): boolean {
		return this.documents.has(id);
	}

	private scoreDocument(
		doc: BM25Document,
		queryTerms: string[],
		totalDocuments: number,
	): number {
		let score = 0;
		const avgdl = this.avgDocLength || 1;

		for (const term of queryTerms) {
			const tf = doc.termFrequencies.get(term) ?? 0;
			if (tf === 0) continue;

			const df = this.documentFrequencies.get(term) ?? 0;
			const idf = Math.log((totalDocuments - df + 0.5) / (df + 0.5) + 1);
			const numerator = tf * (this.k1 + 1);
			const denominator =
				tf + this.k1 * (1 - this.b + this.b * (doc.length / avgdl));
			score += idf * (numerator / denominator);
		}

		return score;
	}

	private recomputeAvgDocLength(): void {
		const docCount = this.documents.size;
		this.avgDocLength = docCount > 0 ? this.totalTermCount / docCount : 0;
	}

	/**
	 * Tokenize text using the shared Tokenizer (for English, CJK, Hangul)
	 * merged with a unicode-aware regex fallback (for Cyrillic, Arabic, etc.).
	 * This ensures all scripts are searchable while still benefiting from
	 * the Tokenizer's stemming and normalization for supported scripts.
	 */
	private tokenize(text: string): string[] {
		if (!text?.trim()) return [];

		// Primary: shared Tokenizer (handles English + CJK + Hangul, with stemming)
		let primaryTokens: string[] = [];
		try {
			primaryTokens = this.sharedTokenizer.tokenize(text).tokens;
		} catch {
			// Tokenizer throws on empty/whitespace-only input after cleaning
			primaryTokens = [];
		}

		// Fallback: unicode-aware regex for scripts the Tokenizer strips
		// (\p{L} matches ANY unicode letter including Cyrillic, Arabic, etc.)
		const fallbackTokens = text
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((t) => t.length >= 2 && !this.stopWords.has(t));

		// Merge: use a Set to deduplicate, primary tokens first
		const merged = new Set(primaryTokens);
		for (const t of fallbackTokens) {
			merged.add(t);
		}

		return Array.from(merged);
	}
}

function sortAndTruncate(results: BM25Result[], topK?: number): BM25Result[] {
	results.sort((a, b) => b.score - a.score);
	return topK !== undefined && topK > 0 ? results.slice(0, topK) : results;
}
