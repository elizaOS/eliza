/**
 * BM25 (Best Match 25) scoring for document retrieval.
 *
 * Implements the Okapi BM25 ranking function for keyword-based relevance
 * scoring over a corpus of text documents.
 *
 * Default parameters follow Robertson et al. (1994):
 *   k1 = 1.5 (term saturation)
 *   b  = 0.75 (length normalization)
 */

export interface Bm25Document {
	id: string;
	text: string;
}

export interface Bm25Score {
	id: string;
	score: number;
}

export interface Bm25Options {
	/** Term frequency saturation. Higher → more weight on repeated terms. Default 1.5 */
	k1?: number;
	/** Document-length normalization. 1.0 = full normalization, 0 = none. Default 0.75 */
	b?: number;
}

/**
 * Tokenize text into lowercase words, stripping punctuation.
 * Shared between index building and query processing.
 */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 0);
}

/**
 * Score each document in `documents` against `query` using BM25.
 *
 * Documents with a score of 0 are included in the result (they simply
 * did not match any query term) so callers can normalize across the
 * full candidate set. Returned array is in the same order as input.
 */
export function bm25Scores(
	query: string,
	documents: Bm25Document[],
	opts?: Bm25Options,
): Bm25Score[] {
	const k1 = opts?.k1 ?? 1.5;
	const b = opts?.b ?? 0.75;

	if (documents.length === 0 || !query.trim()) {
		return documents.map((doc) => ({ id: doc.id, score: 0 }));
	}

	const queryTerms = tokenize(query);
	if (queryTerms.length === 0) {
		return documents.map((doc) => ({ id: doc.id, score: 0 }));
	}

	// Tokenize all documents once
	const tokenizedDocs: string[][] = documents.map((doc) => tokenize(doc.text));

	// Average document length
	const totalLength = tokenizedDocs.reduce((sum, toks) => sum + toks.length, 0);
	const avgDocLength = totalLength / documents.length;

	// Document-frequency per term (how many docs contain the term)
	const docFreq = new Map<string, number>();
	for (const toks of tokenizedDocs) {
		const seen = new Set<string>();
		for (const tok of toks) {
			if (!seen.has(tok)) {
				seen.add(tok);
				docFreq.set(tok, (docFreq.get(tok) ?? 0) + 1);
			}
		}
	}

	const N = documents.length;

	// Score each document
	return tokenizedDocs.map((toks, docIndex) => {
		const docLength = toks.length;

		// Term-frequency map for this document
		const termFreq = new Map<string, number>();
		for (const tok of toks) {
			termFreq.set(tok, (termFreq.get(tok) ?? 0) + 1);
		}

		let score = 0;
		for (const term of queryTerms) {
			const tf = termFreq.get(term) ?? 0;
			if (tf === 0) continue;

			const df = docFreq.get(term) ?? 0;
			// IDF: smoothed log, +1 avoids log(1) = 0 for ubiquitous terms
			const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

			const tfNorm =
				(tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgDocLength)));

			score += idf * tfNorm;
		}

		return { id: documents[docIndex].id, score };
	});
}

/**
 * Normalize an array of BM25 scores to [0, 1].
 * All-zero arrays are returned unchanged.
 */
export function normalizeBm25Scores(scores: Bm25Score[]): Bm25Score[] {
	const maxScore = Math.max(...scores.map((s) => s.score));
	if (maxScore === 0) return scores;
	return scores.map((s) => ({ id: s.id, score: s.score / maxScore }));
}
