/**
 * Recall-benchmark metric schema (#9956).
 *
 * Single source of truth for the per-search-mode record the recall-bench
 * harness emits. The harness drives the REAL `@elizaos/core` recall pipeline
 * (DocumentService.searchDocuments over hybrid / vector / keyword, the
 * low-level runtime.searchMemories + embedRecallQuery path, and the
 * scoreMemoryText chat-search surface) and reports IR quality (Precision@K,
 * Recall@K, MRR, nDCG@K, HitRate@K) + retrieval latency (p50/p95) per mode.
 *
 * Honesty contract: a row is `measured: true` ONLY when the real pipeline ran
 * and scored real queries. An unmeasured row is built via `skippedRow` and has
 * EVERY numeric field `null` (never 0) — "not measured" is never conflated with
 * "zero". A `mode: "self-check"` self-check row proves the pipeline scores at
 * all but can never satisfy a real quality gate.
 *
 * Pure ESM, built-ins only — importable from `.mjs` (run under node) and from
 * `.ts` (run under bun --conditions=eliza-source) via the same relative path.
 */

/** Schema version. Bump on any breaking field change so consumers detect drift. */
export const METRIC_SCHEMA_VERSION = "1.0.0";

/**
 * The recall surfaces the harness exercises. One report row per surface.
 *   - hybrid / vector / keyword → DocumentService.searchDocuments(mode)
 *   - runtime-vector            → low-level runtime.searchMemories + embedRecallQuery
 *   - keyword-chat-search       → scoreMemoryText (the chat-search surface in
 *                                 packages/agent/src/api/memory-routes.ts)
 */
export const SEARCH_MODES = /** @type {const} */ ([
	"hybrid",
	"vector",
	"keyword",
	"runtime-vector",
	"keyword-chat-search",
]);

/** The k cut-offs the harness reports for every metric. */
export const K_VALUES = /** @type {const} */ ([1, 3, 5, 10]);

/**
 * The canonical per-mode metric record.
 *
 * @typedef {Object} ModeMetric
 * @property {string}  mode           One of SEARCH_MODES.
 * @property {boolean} measured       true when the real pipeline scored real queries; false when skipped.
 * @property {string=} skipReason     Present iff measured === false — why this row was not measured.
 * @property {number|null} numQueries Queries scored for this mode.
 * @property {Record<number, number|null>} precisionAtK  Precision@k per k in K_VALUES.
 * @property {Record<number, number|null>} recallAtK     Recall@k per k.
 * @property {number|null}                 mrr           Mean reciprocal rank.
 * @property {Record<number, number|null>} ndcgAtK       nDCG@k per k.
 * @property {Record<number, number|null>} hitRateAtK    HitRate@k per k.
 * @property {number|null} latencyMsP50  Median per-query retrieval latency (ms).
 * @property {number|null} latencyMsP95  p95 per-query retrieval latency (ms).
 * @property {number|null} recallAt5     Convenience headline: recallAtK[5].
 * @property {number|null} ndcgAt10      Convenience headline: ndcgAtK[10].
 */

/** Build the null-filled k-map (one entry per k, every value null). */
function nullKMap() {
	const m = {};
	for (const k of K_VALUES) m[k] = null;
	return m;
}

/** The top-level report envelope. */
export const METRIC_SCHEMA = Object.freeze({
	version: METRIC_SCHEMA_VERSION,
	/** Field names a consumer can rely on per mode row. */
	modeFields: Object.freeze([
		"mode",
		"measured",
		"skipReason",
		"numQueries",
		"precisionAtK",
		"recallAtK",
		"mrr",
		"ndcgAtK",
		"hitRateAtK",
		"latencyMsP50",
		"latencyMsP95",
		"recallAt5",
		"ndcgAt10",
	]),
	/** Numeric fields that MUST be null (not 0) on an unmeasured row. */
	nullableScoreFields: Object.freeze([
		"numQueries",
		"mrr",
		"latencyMsP50",
		"latencyMsP95",
		"recallAt5",
		"ndcgAt10",
	]),
	/** Per-k field groups whose every entry is null on an unmeasured row. */
	nullableKMapFields: Object.freeze([
		"precisionAtK",
		"recallAtK",
		"ndcgAtK",
		"hitRateAtK",
	]),
	searchModes: SEARCH_MODES,
	kValues: K_VALUES,
	issue: "#9956",
});

/**
 * Build an unmeasured (skipped) mode row with every numeric field null.
 * Never emit 0 for an unmeasured value.
 */
export function skippedRow(mode, reason) {
	return {
		mode,
		measured: false,
		skipReason: reason,
		numQueries: null,
		precisionAtK: nullKMap(),
		recallAtK: nullKMap(),
		mrr: null,
		ndcgAtK: nullKMap(),
		hitRateAtK: nullKMap(),
		latencyMsP50: null,
		latencyMsP95: null,
		recallAt5: null,
		ndcgAt10: null,
	};
}
