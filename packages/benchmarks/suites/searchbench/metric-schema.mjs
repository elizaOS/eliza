/**
 * Metric schema for the chat-message searchbench (#13534) — the single source
 * of truth for the per-query and aggregate records the harness emits so
 * `run-all.mjs` and any consumer read the same field names.
 *
 * The honesty contract mirrors memperf: a metric is `measured:true` only when a
 * real query against a real ≥10k-row PGlite store produced it. An unmeasured
 * metric is `null`, never `0` — a fabricated zero recall would silently pass a
 * budget. Pure ESM, built-ins only.
 */

export const METRIC_SCHEMA_VERSION = "1.0.0";

/** The retrieval-quality metrics computed over the labeled gold set. */
export const QUALITY_METRICS = /** @type {const} */ ([
  "precisionAt10",
  "recallAt10",
  "mrr",
  "ndcgAt10",
]);

/** The latency metrics computed over the per-query wall-clock timings. */
export const LATENCY_METRICS = /** @type {const} */ ([
  "p50LatencyMs",
  "p95LatencyMs",
  "maxLatencyMs",
]);

/**
 * One gold-query result row.
 *
 * @typedef {Object} GoldQueryResult
 * @property {string}  id            gold-case id (e.g. "multiword-nonadjacent").
 * @property {string}  query         the raw query string sent to searchMessages.
 * @property {string}  kind          edge-case category (multiword|partial|accent|phrase|url|emoji|cjk|older-hit|...).
 * @property {number}  relevant      count of gold-relevant messages for this query.
 * @property {number}  returned      count of rows the store returned.
 * @property {number}  hitsAt10      relevant rows present in the top-10.
 * @property {number}  recallAt10    hitsAt10 / relevant.
 * @property {number}  precisionAt10 hitsAt10 / min(10, returned).
 * @property {number}  reciprocalRank 1 / rank-of-first-relevant, 0 if none.
 * @property {number}  ndcgAt10      binary-relevance nDCG over the top-10.
 * @property {number}  latencyMs     wall-clock ms for this query.
 */

/** The top-level report envelope. */
export const METRIC_SCHEMA = Object.freeze({
  version: METRIC_SCHEMA_VERSION,
  qualityMetrics: QUALITY_METRICS,
  latencyMetrics: LATENCY_METRICS,
  goldQueryFields: Object.freeze([
    "id",
    "query",
    "kind",
    "relevant",
    "returned",
    "hitsAt10",
    "recallAt10",
    "precisionAt10",
    "reciprocalRank",
    "ndcgAt10",
    "latencyMs",
  ]),
  consumers: Object.freeze(["#13534", "#9955"]),
});

/** Binary-relevance nDCG@k for a ranked list of booleans (true = relevant). */
export function ndcgAtK(relevanceFlags, k) {
  const rels = relevanceFlags.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < rels.length; i++) {
    if (rels[i]) dcg += 1 / Math.log2(i + 2);
  }
  const idealCount = Math.min(k, relevanceFlags.filter(Boolean).length);
  let idcg = 0;
  for (let i = 0; i < idealCount; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}
