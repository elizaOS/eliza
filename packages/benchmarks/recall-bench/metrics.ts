/**
 * recall-bench — information-retrieval quality metrics (#9956).
 *
 * Pure, deterministic scoring for the memory-recall / knowledge-retrieval
 * benchmark: Precision@K, Recall@K, MRR, nDCG@K, HitRate@K, and latency
 * percentiles. This is the foundation the rest of #9956 builds on — the harness
 * that drives the REAL `@elizaos/core` recall path (`AgentRuntime.searchMemories`
 * + `DocumentService.searchDocuments`) over a labelled, document-scale corpus
 * feeds its per-query results through these functions, then compares the
 * summary against committed budgets in CI.
 *
 * Definitions are the standard IR ones, fixed here so a regression in the bench
 * itself is caught by `metrics.test.ts`:
 *   - A "result" is an ordered list of retrieved ids (most-relevant first).
 *   - "relevant" is the ground-truth set of ids that SHOULD be retrieved.
 *   - Precision@K divides by K (unfilled slots below `retrieved.length` count as
 *     non-relevant — the standard fixed-K convention), so P@K is comparable
 *     across queries regardless of how many docs a mode returned.
 *   - Recall@K divides by |relevant|; 0 when there are no relevant ids.
 *   - nDCG@K uses binary gains (1 relevant / 0 not) and log2(rank+1) discount.
 */

export interface QueryResult {
  /** Retrieved ids in rank order (index 0 = top hit). */
  readonly retrieved: readonly string[];
  /** Ground-truth relevant ids for this query. */
  readonly relevant: ReadonlySet<string>;
}

function topK(retrieved: readonly string[], k: number): readonly string[] {
  if (k <= 0) return [];
  return retrieved.slice(0, k);
}

/** |relevant ∩ retrieved[:k]| / k. Denominator is K (fixed-K convention). */
export function precisionAtK(result: QueryResult, k: number): number {
  if (k <= 0) return 0;
  const hits = topK(result.retrieved, k).filter((id) =>
    result.relevant.has(id),
  ).length;
  return hits / k;
}

/** |relevant ∩ retrieved[:k]| / |relevant|. 0 when nothing is relevant. */
export function recallAtK(result: QueryResult, k: number): number {
  if (result.relevant.size === 0) return 0;
  const hits = topK(result.retrieved, k).filter((id) =>
    result.relevant.has(id),
  ).length;
  return hits / result.relevant.size;
}

/** 1 if any of the top-k are relevant, else 0. */
export function hitRateAtK(result: QueryResult, k: number): number {
  return topK(result.retrieved, k).some((id) => result.relevant.has(id))
    ? 1
    : 0;
}

/** 1 / (1-based rank of the first relevant hit); 0 when none is retrieved. */
export function reciprocalRank(result: QueryResult): number {
  const idx = result.retrieved.findIndex((id) => result.relevant.has(id));
  return idx === -1 ? 0 : 1 / (idx + 1);
}

/** Discounted cumulative gain over the top-k with binary relevance. */
export function dcgAtK(result: QueryResult, k: number): number {
  return topK(result.retrieved, k).reduce((acc, id, i) => {
    if (!result.relevant.has(id)) return acc;
    // gain 1, discounted by log2(rank+1) with rank = i+1 → log2(i+2).
    return acc + 1 / Math.log2(i + 2);
  }, 0);
}

/** Ideal DCG@k: all relevant docs packed into the top positions. */
export function idealDcgAtK(result: QueryResult, k: number): number {
  const ideal = Math.min(result.relevant.size, Math.max(k, 0));
  let sum = 0;
  for (let i = 0; i < ideal; i += 1) sum += 1 / Math.log2(i + 2);
  return sum;
}

/** nDCG@k = DCG@k / IDCG@k; 0 when there is no ideal gain (no relevant docs). */
export function ndcgAtK(result: QueryResult, k: number): number {
  const idcg = idealDcgAtK(result, k);
  if (idcg === 0) return 0;
  return dcgAtK(result, k) / idcg;
}

/**
 * Nearest-rank percentile of a sample set (e.g. latency ms). p in [0,100].
 * Returns null for an empty sample (the memperf honesty contract: unmeasured
 * rows are null, never 0).
 */
export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(100, Math.max(0, p));
  if (clamped === 0) return sorted[0];
  const rank = Math.ceil((clamped / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export interface RecallSummary {
  readonly queries: number;
  readonly k: number;
  /** Mean metric across all queries, or null when there are no queries. */
  readonly precisionAtK: number | null;
  readonly recallAtK: number | null;
  readonly mrr: number | null;
  readonly ndcgAtK: number | null;
  readonly hitRateAtK: number | null;
  /** Latency percentiles (ms), null when no latencies were supplied. */
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  /** True only when at least one query was actually scored (memperf contract). */
  readonly measured: boolean;
}

/**
 * Aggregate per-query results into the summary CI compares against budgets.
 * `latenciesMs` is optional and independent of the result count (a run may
 * score quality without timing, or vice versa).
 */
export function summarizeRecall(
  results: readonly QueryResult[],
  k: number,
  latenciesMs: readonly number[] = [],
): RecallSummary {
  return {
    queries: results.length,
    k,
    precisionAtK: mean(results.map((r) => precisionAtK(r, k))),
    recallAtK: mean(results.map((r) => recallAtK(r, k))),
    mrr: mean(results.map((r) => reciprocalRank(r))),
    ndcgAtK: mean(results.map((r) => ndcgAtK(r, k))),
    hitRateAtK: mean(results.map((r) => hitRateAtK(r, k))),
    p50LatencyMs: percentile(latenciesMs, 50),
    p95LatencyMs: percentile(latenciesMs, 95),
    measured: results.length > 0,
  };
}
