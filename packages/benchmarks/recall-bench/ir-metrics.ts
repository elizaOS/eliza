/**
 * Information-retrieval quality metrics for recall-bench (#9956).
 *
 * A direct TypeScript port of the semantics in
 * `packages/benchmarks/experience/elizaos_experience_bench/evaluators/retrieval.py`
 * (Precision@K / Recall@K / MRR / HitRate@K) plus the standard textbook binary
 * nDCG@K (which has no first-class reference in the repo). Binary relevance.
 * Every metric is macro-averaged over the query set.
 *
 * Load-bearing semantics that MUST be preserved (they match retrieval.py):
 *   - Precision@K = |topK ∩ relevant| / k   — divides by k itself, NOT by
 *     min(k, #results). Fewer-than-k results are penalised against k.
 *   - Recall@K    = |topK ∩ relevant| / |relevant|, 0 when relevant is empty.
 *   - HitRate@K   = 1 if any relevant id appears in topK, else 0.
 *   - MRR         = reciprocal rank of the FIRST relevant hit (1-based) walking
 *     the RAW ordered result list (no de-dup); 0 when no hit. Ties are resolved
 *     purely by the upstream ranker's list order.
 *   - nDCG@K      = DCG@K / IDCG@K (binary rel), IDCG over min(K, |relevant|)
 *     ideal positions; 0 when |relevant| == 0.
 *   - P/R/Hit de-dup the top-k via a Set (a doubled id counts once); MRR does
 *     not (it walks the raw list).
 */

export interface RankedQuery {
	/** Ranked result ids, best-first, as returned by the retriever (may contain dups). */
	resultIds: string[];
	/** Ground-truth relevant fragment ids for this query. */
	relevantIds: Set<string>;
}

export interface RetrievalMetrics {
	precisionAtK: Record<number, number>;
	recallAtK: Record<number, number>;
	meanReciprocalRank: number;
	hitRateAtK: Record<number, number>;
	ndcgAtK: Record<number, number>;
	numQueries: number;
}

/** Precision@K = |topK ∩ relevant| / k  (divides by k, not by min(k, #results)). */
export function precisionAtK(
	resultIds: string[],
	relevant: Set<string>,
	k: number,
): number {
	if (k <= 0) return 0;
	const topK = new Set(resultIds.slice(0, k));
	let hits = 0;
	for (const id of topK) if (relevant.has(id)) hits++;
	return hits / k;
}

/** Recall@K = |topK ∩ relevant| / |relevant|  (0 when relevant is empty). */
export function recallAtK(
	resultIds: string[],
	relevant: Set<string>,
	k: number,
): number {
	if (relevant.size === 0) return 0;
	const topK = new Set(resultIds.slice(0, k));
	let hits = 0;
	for (const id of topK) if (relevant.has(id)) hits++;
	return hits / relevant.size;
}

/** HitRate@K = 1 if any relevant doc is in topK else 0. */
export function hitRateAtK(
	resultIds: string[],
	relevant: Set<string>,
	k: number,
): number {
	for (const id of resultIds.slice(0, k)) if (relevant.has(id)) return 1;
	return 0;
}

/**
 * Reciprocal rank of the FIRST relevant hit (1-based) over the raw ordered
 * list; 0 if none. No de-dup — a duplicated earlier hit keeps its rank.
 */
export function reciprocalRank(
	resultIds: string[],
	relevant: Set<string>,
): number {
	for (let i = 0; i < resultIds.length; i++) {
		if (relevant.has(resultIds[i])) return 1 / (i + 1); // rank is 1-based
	}
	return 0;
}

/**
 * Binary nDCG@K = DCG@K / IDCG@K, with IDCG over min(K, |relevant|) ideal
 * positions; 0 when |relevant| == 0.
 */
export function ndcgAtK(
	resultIds: string[],
	relevant: Set<string>,
	k: number,
): number {
	let dcg = 0;
	const topK = resultIds.slice(0, k);
	for (let i = 0; i < topK.length; i++) {
		// i+2 == log2(rank+1) with rank = i+1.
		if (relevant.has(topK[i])) dcg += 1 / Math.log2(i + 2);
	}
	const idealHits = Math.min(k, relevant.size);
	let idcg = 0;
	for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
	return idcg === 0 ? 0 : dcg / idcg;
}

/** Macro-average all metrics over a query set. */
export function evaluateRetrieval(
	queries: RankedQuery[],
	kValues: number[],
): RetrievalMetrics {
	const n = queries.length || 1;
	const init = () =>
		Object.fromEntries(kValues.map((k) => [k, 0])) as Record<number, number>;
	const pSum = init();
	const rSum = init();
	const hSum = init();
	const gSum = init();
	let mrrSum = 0;
	for (const q of queries) {
		mrrSum += reciprocalRank(q.resultIds, q.relevantIds);
		for (const k of kValues) {
			pSum[k] += precisionAtK(q.resultIds, q.relevantIds, k);
			rSum[k] += recallAtK(q.resultIds, q.relevantIds, k);
			hSum[k] += hitRateAtK(q.resultIds, q.relevantIds, k);
			gSum[k] += ndcgAtK(q.resultIds, q.relevantIds, k);
		}
	}
	const avg = (m: Record<number, number>) =>
		Object.fromEntries(kValues.map((k) => [k, m[k] / n])) as Record<
			number,
			number
		>;
	return {
		precisionAtK: avg(pSum),
		recallAtK: avg(rSum),
		meanReciprocalRank: mrrSum / n,
		hitRateAtK: avg(hSum),
		ndcgAtK: avg(gSum),
		numQueries: queries.length,
	};
}

/** p50/p95 latency over a sample of millisecond timings (nearest-rank percentile). */
export function percentiles(samplesMs: number[]): {
	p50: number | null;
	p95: number | null;
} {
	if (samplesMs.length === 0) return { p50: null, p95: null };
	const sorted = [...samplesMs].sort((a, b) => a - b);
	const at = (p: number) => {
		// Nearest-rank: rank = ceil(p/100 * n), 1-based.
		const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
		return sorted[rank - 1];
	};
	return { p50: at(50), p95: at(95) };
}
