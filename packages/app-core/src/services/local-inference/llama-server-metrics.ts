/**
 * Scraper for llama-server's `/metrics` (Prometheus exposition format)
 * endpoint. Translates the running counters into the
 * Anthropic-SDK-shaped `usage` block that callers already know how to
 * consume from the cloud Anthropic plugin.
 *
 * llama-server publishes the following counters (per-process, monotonic):
 *
 *   llamacpp:n_decode_total           — context tokens decoded (prefill + gen)
 *   llamacpp:n_tokens_predicted_total — output tokens
 *   llamacpp:prompt_tokens_total      — total input tokens accepted
 *   llamacpp:n_past_max               — high-water mark of cached past-tokens
 *   llamacpp:n_prompt_tokens_processed_total — fresh tokens prefilled
 *                                       (i.e. cache MISS), excludes cache hits
 *   llamacpp:kv_cache_tokens          — current size of KV cache (gauge)
 *   llamacpp:kv_cache_used_cells      — slots with active KV (gauge)
 *
 * For DFlash speculative decoding, the fork additionally publishes:
 *
 *   llamacpp:n_drafted_total          — drafter-emitted tokens
 *   llamacpp:n_drafted_accepted_total — accepted speculative tokens
 *
 * The mapping into Anthropic shape:
 *
 *   prompt_tokens_total                              → input_tokens
 *   n_tokens_predicted_total                         → output_tokens
 *   n_prompt_tokens_processed_total                  → cache_creation_input_tokens
 *   prompt_tokens_total - n_prompt_tokens_processed_total → cache_read_input_tokens
 *   n_drafted_total / n_drafted_accepted_total       → DFlash extension fields
 *
 * Counters are taken as deltas across two snapshots: take one before
 * `generate`, one after, and subtract. Losing a few samples to process
 * restart is acceptable — the deltas are useful for the call's own
 * usage accounting, not for global monitoring.
 */

export interface LlamaServerMetricSnapshot {
  /** Wall-clock ms when the snapshot was taken; useful for diagnostics. */
  takenAtMs: number;
  /** True when `/metrics` was fetched and parsed. False means scrape failure. */
  scrapeOk?: boolean;
  /** True when the scrape included at least one generation/speculation counter. */
  hasGenerationCounters?: boolean;
  promptTokensTotal: number;
  predictedTokensTotal: number;
  /** Tokens that had to be freshly prefilled — i.e. cache MISS this turn. */
  promptTokensProcessedTotal: number;
  draftedTotal: number;
  acceptedTotal: number;
  /** Current size of the KV cache (gauge). */
  kvCacheTokens: number;
  /** Number of slots currently holding active KV (gauge). */
  kvCacheUsedCells: number;
}

type MetricNumericField = Exclude<
  keyof LlamaServerMetricSnapshot,
  "scrapeOk" | "hasGenerationCounters"
>;

const METRIC_KEYS: Record<string, MetricNumericField> = {
  "llamacpp:prompt_tokens_total": "promptTokensTotal",
  "llamacpp:n_tokens_predicted_total": "predictedTokensTotal",
  "llamacpp:n_prompt_tokens_processed_total": "promptTokensProcessedTotal",
  "llamacpp:n_drafted_total": "draftedTotal",
  "llamacpp:n_drafted": "draftedTotal",
  "llamacpp:n_drafted_accepted_total": "acceptedTotal",
  "llamacpp:n_drafted_accepted": "acceptedTotal",
  "llamacpp:n_accepted_total": "acceptedTotal",
  "llamacpp:n_accepted": "acceptedTotal",
  "llamacpp:kv_cache_tokens": "kvCacheTokens",
  "llamacpp:kv_cache_used_cells": "kvCacheUsedCells",
};

/**
 * Parse a Prometheus exposition-format payload into a metric snapshot.
 * Unknown or malformed lines are silently skipped — counters we don't
 * recognise are not interesting and metric exporters add new ones over
 * time.
 *
 * llama-server usually exposes one sample per metric (no labels), e.g.
 *   `llamacpp:prompt_tokens_total 1234`
 * Some DFlash forks expose per-slot labelled samples, e.g.
 *   `llamacpp:n_drafted_accepted_total{slot_id="0"} 12`
 * Labelled samples are summed unless an unlabelled total exists for the same
 * canonical field, in which case the unlabelled total wins.
 */
export function parsePrometheusMetrics(
  body: string,
  takenAtMs: number = Date.now(),
): LlamaServerMetricSnapshot {
  const snapshot: LlamaServerMetricSnapshot = {
    takenAtMs,
    scrapeOk: true,
    hasGenerationCounters: false,
    promptTokensTotal: 0,
    predictedTokensTotal: 0,
    promptTokensProcessedTotal: 0,
    draftedTotal: 0,
    acceptedTotal: 0,
    kvCacheTokens: 0,
    kvCacheUsedCells: 0,
  };
  const buckets = new Map<
    MetricNumericField,
    { unlabeled: number | null; labeledSum: number }
  >();
  let hasGenerationCounters = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Prometheus line format: `name{labels?} value [timestamp]`.
    const match = line.match(
      /^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i,
    );
    if (!match) continue;
    const name = match[1];
    const labels = match[2];
    const value = Number(match[3]);
    if (!Number.isFinite(value) || name === undefined) continue;
    const field = METRIC_KEYS[name];
    if (!field) continue;
    if (
      field === "promptTokensTotal" ||
      field === "predictedTokensTotal" ||
      field === "promptTokensProcessedTotal" ||
      field === "draftedTotal" ||
      field === "acceptedTotal"
    ) {
      hasGenerationCounters = true;
    }
    const bucket = buckets.get(field) ?? { unlabeled: null, labeledSum: 0 };
    if (labels) bucket.labeledSum += value;
    else bucket.unlabeled = value;
    buckets.set(field, bucket);
  }

  for (const [field, bucket] of buckets) {
    snapshot[field] = bucket.unlabeled ?? bucket.labeledSum;
  }

  snapshot.hasGenerationCounters = hasGenerationCounters;

  return snapshot;
}

/**
 * Anthropic-SDK-shaped usage block, optionally extended with DFlash
 * speculative-decoding metrics. The cloud plugin (plugin-anthropic)
 * emits the first three fields verbatim; local inference adds the
 * `dflash_*` fields when speculative decoding is active. Callers that
 * already handle the cloud `usage` shape need no change.
 */
export interface LocalUsageBlock {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  dflash_drafted_tokens?: number;
  dflash_accepted_tokens?: number;
  /** 0..1 — proportion of drafted tokens that were accepted. */
  dflash_acceptance_rate?: number;
  /** 0..1 — proportion of input tokens that hit a warm slot (cache reuse). */
  cache_hit_rate?: number;
}

/**
 * Compute the Anthropic-shape usage block for a single generation by
 * differencing two snapshots. `before` is taken just before the request,
 * `after` just after the response was received. Negative deltas (caused
 * by a metric reset between snapshots, e.g. server restart) are clamped
 * to 0 — losing the sample is preferable to surfacing nonsense to the
 * caller.
 *
 * Pass `responseUsage` to override input/output counts when the response
 * payload itself reports per-call counters that are more accurate than
 * the metric delta — llama-server's chat completion response includes
 * `usage.{prompt,completion}_tokens` per request, which is exact while
 * the metric delta is "everything that happened during the wall-clock
 * window of the request."
 */
export function diffSnapshots(
  before: LlamaServerMetricSnapshot,
  after: LlamaServerMetricSnapshot,
  responseUsage?: { prompt_tokens?: number; completion_tokens?: number },
): LocalUsageBlock {
  const promptDelta = clampNonNegative(
    after.promptTokensTotal - before.promptTokensTotal,
  );
  const predictedDelta = clampNonNegative(
    after.predictedTokensTotal - before.predictedTokensTotal,
  );
  const processedDelta = clampNonNegative(
    after.promptTokensProcessedTotal - before.promptTokensProcessedTotal,
  );
  const draftedDelta = clampNonNegative(
    after.draftedTotal - before.draftedTotal,
  );
  const acceptedDelta = clampNonNegative(
    after.acceptedTotal - before.acceptedTotal,
  );

  const responsePrompt = responseUsage?.prompt_tokens ?? promptDelta;
  const responseCompletion = responseUsage?.completion_tokens ?? predictedDelta;

  const inputTokens = responsePrompt;
  const outputTokens = responseCompletion;
  // Tokens that had to be freshly prefilled this call. Bounded above by
  // the per-call input count — a metric-delta wider than the call's own
  // input is a sampling artifact.
  const cacheCreation = Math.min(processedDelta, inputTokens);
  const cacheRead = Math.max(0, inputTokens - cacheCreation);

  const block: LocalUsageBlock = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
  };
  if (inputTokens > 0) {
    block.cache_hit_rate = cacheRead / inputTokens;
  }
  if (draftedDelta > 0) {
    block.dflash_drafted_tokens = draftedDelta;
    block.dflash_accepted_tokens = acceptedDelta;
    block.dflash_acceptance_rate = acceptedDelta / draftedDelta;
  }
  return block;
}

function clampNonNegative(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value;
}

/**
 * GET `/metrics` from a running llama-server and parse it. Errors fall
 * back to a zero-valued snapshot rather than throwing — observability
 * MUST NOT break generation. `scrapeOk=false` tells callers that the
 * zeros are not evidence of absent DFlash/KV activity.
 */
export async function fetchMetricsSnapshot(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<LlamaServerMetricSnapshot> {
  const takenAtMs = Date.now();
  const empty: LlamaServerMetricSnapshot = {
    takenAtMs,
    scrapeOk: false,
    hasGenerationCounters: false,
    promptTokensTotal: 0,
    predictedTokensTotal: 0,
    promptTokensProcessedTotal: 0,
    draftedTotal: 0,
    acceptedTotal: 0,
    kvCacheTokens: 0,
    kvCacheUsedCells: 0,
  };
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/metrics`, {
      method: "GET",
      signal,
    });
    if (!res.ok) return empty;
    const body = await res.text();
    return parsePrometheusMetrics(body, takenAtMs);
  } catch {
    // Best effort: a metrics scrape failure must not abort the response
    // path. Returning an empty snapshot causes diffSnapshots to surface
    // zero deltas; the caller still sees the response payload usage.
    return empty;
  }
}
