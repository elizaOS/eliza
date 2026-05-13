/**
 * L1 — DFlash verify-event protocol.
 *
 * Wire format: `docs/eliza-1-dflash-events-wire.md`. The C-side
 * `llama-server` fork emits one of these on the top-level `dflashVerify`
 * field of every SSE chunk that wraps a speculative-decoding verify
 * step, when launched with `--dflash-emit-verify-events`. Today the JS
 * runtime synthesises `accept`/`reject` `VerifierStreamEvent`s from
 * each text delta; this module gives the runtime a typed parse of the
 * native record so the autotuner / voice rollback heuristic can use
 * exact accept counts, reject indices, and per-token logprobs instead.
 *
 * This module is intentionally standalone (no dependency on the older
 * `dflash-event-schema.ts` union-shape parser). Both protocols coexist
 * on the same SSE chunk; consumers wire whichever they need.
 *
 * The protocol is additive: when the binary does not emit
 * `dflashVerify`, this module's parsers return empty arrays and the
 * legacy synthesis path runs unchanged.
 */

/**
 * One drafter-/verifier-emitted token with its target-evaluated
 * log-probability. `logprob` is finite or `-Infinity`; NaN drops the
 * containing event (the JS consumers compare logprobs to thresholds
 * and NaN would short-circuit those checks incorrectly).
 */
export interface DflashVerifyToken {
  id: number;
  logprob: number;
}

/**
 * One verify step recorded by the C-side `dflash` impl. Invariants
 * (checked by `parseDflashVerifyEvent`):
 *
 *   - `acceptCount >= 0 && acceptCount <= draftedTokens.length`
 *   - `rejectIndex === null` iff `acceptCount === draftedTokens.length`
 *   - When non-null, `rejectIndex === acceptCount`
 *   - `correctionToken` non-null iff `rejectIndex` non-null
 *   - `postCorrectionTokens.length >= 0`
 */
export interface DflashVerifyEvent {
  kind: "dflash-verify";
  draftedTokens: readonly DflashVerifyToken[];
  acceptCount: number;
  rejectIndex: number | null;
  correctionToken: DflashVerifyToken | null;
  postCorrectionTokens: readonly DflashVerifyToken[];
  ts: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isLogprob(value: unknown): value is number {
  if (typeof value !== "number") return false;
  return Number.isFinite(value) || value === -Infinity;
}

function parseToken(value: unknown): DflashVerifyToken | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (!isNonNegativeInt(obj.id) || !isLogprob(obj.logprob)) return null;
  return { id: obj.id, logprob: obj.logprob };
}

function parseTokenArray(value: unknown): DflashVerifyToken[] | null {
  if (!Array.isArray(value)) return null;
  const out: DflashVerifyToken[] = [];
  for (const entry of value) {
    const parsed = parseToken(entry);
    if (!parsed) return null;
    out.push(parsed);
  }
  return out;
}

/**
 * Parse a JSON value into a `DflashVerifyEvent`. Returns null on any
 * shape mismatch — the caller treats parse failures as "no native event
 * present" and falls back to the legacy synthesis path.
 *
 * Accepts both snake_case (the wire format) and camelCase (already-
 * adapted by a friendly emitter) field names.
 */
export function parseDflashVerifyEvent(raw: unknown): DflashVerifyEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== "dflash-verify") return null;
  if (!isFiniteNumber(obj.ts)) return null;

  const draftedRaw = obj.draftedTokens ?? obj.drafted_tokens;
  const drafted = parseTokenArray(draftedRaw);
  if (!drafted) return null;

  const acceptRaw = obj.acceptCount ?? obj.accept_count;
  if (!isNonNegativeInt(acceptRaw)) return null;
  if (acceptRaw > drafted.length) return null;

  const rejectRaw = obj.rejectIndex ?? obj.reject_index;
  let rejectIndex: number | null;
  if (rejectRaw === null || rejectRaw === undefined) {
    rejectIndex = null;
  } else if (isNonNegativeInt(rejectRaw)) {
    rejectIndex = rejectRaw;
  } else {
    return null;
  }
  // Invariant: rejectIndex null iff acceptCount === drafted.length.
  if (rejectIndex === null && acceptRaw !== drafted.length) return null;
  if (rejectIndex !== null) {
    if (rejectIndex !== acceptRaw) return null;
    if (rejectIndex >= drafted.length) return null;
  }

  const correctionRaw = obj.correctionToken ?? obj.correction_token ?? null;
  let correction: DflashVerifyToken | null;
  if (correctionRaw === null || correctionRaw === undefined) {
    correction = null;
  } else {
    correction = parseToken(correctionRaw);
    if (!correction) return null;
  }
  if (rejectIndex === null && correction !== null) return null;
  if (rejectIndex !== null && correction === null) return null;

  const postRaw = obj.postCorrectionTokens ?? obj.post_correction_tokens ?? [];
  const post = parseTokenArray(postRaw);
  if (!post) return null;

  return {
    kind: "dflash-verify",
    draftedTokens: drafted,
    acceptCount: acceptRaw,
    rejectIndex,
    correctionToken: correction,
    postCorrectionTokens: post,
    ts: obj.ts,
  };
}

/**
 * Extract verify events from a parsed SSE chunk. Looks at the
 * `dflashVerify` top-level field (preferred) and the optional
 * `dflash` field (when the fork co-emits the verify event under the
 * union-shape protocol for forward compat). Returns [] when neither is
 * present.
 */
export function parseDflashVerifyEventsFromSseChunk(
  parsed: unknown,
): DflashVerifyEvent[] {
  if (!parsed || typeof parsed !== "object") return [];
  const out: DflashVerifyEvent[] = [];
  const collect = (field: unknown): void => {
    if (field === undefined || field === null) return;
    if (Array.isArray(field)) {
      for (const entry of field) {
        const ev = parseDflashVerifyEvent(entry);
        if (ev) out.push(ev);
      }
      return;
    }
    const ev = parseDflashVerifyEvent(field);
    if (ev) out.push(ev);
  };
  collect((parsed as Record<string, unknown>).dflashVerify);
  // The verify event may also ride on the union `dflash` field when the
  // fork is in the transition window between the two shapes. Filter to
  // verify-kind only.
  const dflashField = (parsed as Record<string, unknown>).dflash;
  if (dflashField) {
    if (Array.isArray(dflashField)) {
      for (const entry of dflashField) {
        const ev = parseDflashVerifyEvent(entry);
        if (ev) out.push(ev);
      }
    } else {
      const ev = parseDflashVerifyEvent(dflashField);
      if (ev) out.push(ev);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-request roll-up
// ---------------------------------------------------------------------------

export interface DflashVerifyStats {
  /** Sum of `draftedTokens.length` across every verify event observed. */
  draftedTokens: number;
  /** Sum of `acceptCount` across every verify event observed. */
  acceptedTokens: number;
  /** `draftedTokens - acceptedTokens`. */
  rejectedTokens: number;
  /** Count of `dflash-verify` events observed. */
  verifySteps: number;
  /**
   * Per-request acceptance rate (`acceptedTokens / draftedTokens`).
   * `null` when zero tokens were drafted in this window — feeding a
   * 0/0 to the autotuner would mis-calibrate `draftMax`.
   */
  acceptanceRate: number | null;
}

export function summarizeVerifyEvents(
  events: readonly DflashVerifyEvent[],
): DflashVerifyStats {
  let drafted = 0;
  let accepted = 0;
  for (const ev of events) {
    drafted += ev.draftedTokens.length;
    accepted += ev.acceptCount;
  }
  return {
    draftedTokens: drafted,
    acceptedTokens: accepted,
    rejectedTokens: drafted - accepted,
    verifySteps: events.length,
    acceptanceRate: drafted === 0 ? null : accepted / drafted,
  };
}

// ---------------------------------------------------------------------------
// /metrics scrape (L1 counters)
// ---------------------------------------------------------------------------

/**
 * Two NEW Prometheus counters that the fork exposes when built with
 * `LLAMA_DFLASH_VERIFY_EVENTS` and run with `--dflash-emit-verify-events`.
 * Absent on stock builds; `present: false` discriminates that case from
 * "present and zero".
 */
export interface DflashVerifyMetricSample {
  /** `llamacpp:n_drafted_rejected_total` — drafted minus accepted, summed. */
  rejectedTokens: number;
  /** `llamacpp:n_verify_steps_total` — count of `dflashVerify` events. */
  verifySteps: number;
  present: boolean;
}

const L1_METRIC_PATTERNS = {
  rejected:
    /^llamacpp:n_drafted_rejected(?:_total)?(?:\{[^}]*\})?\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i,
  verify:
    /^llamacpp:n_verify_steps(?:_total)?(?:\{[^}]*\})?\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i,
} as const;

/**
 * Parse the two L1 verify counters out of a Prometheus exposition body.
 * Returns `{ present: false }` (with zeros) when neither line is found.
 * Labelled samples are summed; unlabelled totals take precedence when
 * both appear (matches the convention in `llama-server-metrics.ts`).
 */
export function parseDflashVerifyMetrics(
  body: string,
): DflashVerifyMetricSample {
  let rejectedUnlabeled: number | null = null;
  let rejectedLabeled = 0;
  let verifyUnlabeled: number | null = null;
  let verifyLabeled = 0;
  let seen = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const rej = line.match(L1_METRIC_PATTERNS.rejected);
    if (rej) {
      seen = true;
      const value = Number(rej[1]);
      if (!Number.isFinite(value)) continue;
      const labeled = line.includes("{");
      if (labeled) rejectedLabeled += value;
      else rejectedUnlabeled = value;
      continue;
    }
    const ver = line.match(L1_METRIC_PATTERNS.verify);
    if (ver) {
      seen = true;
      const value = Number(ver[1]);
      if (!Number.isFinite(value)) continue;
      const labeled = line.includes("{");
      if (labeled) verifyLabeled += value;
      else verifyUnlabeled = value;
    }
  }

  return {
    rejectedTokens: rejectedUnlabeled ?? rejectedLabeled,
    verifySteps: verifyUnlabeled ?? verifyLabeled,
    present: seen,
  };
}

/**
 * Compute the per-request delta of the two L1 counters across two
 * scrapes. Returns `null` when neither scrape saw the L1 counters
 * (stock build). Negative deltas (server restart between scrapes) are
 * clamped to zero.
 */
export function diffDflashVerifyMetrics(
  before: DflashVerifyMetricSample,
  after: DflashVerifyMetricSample,
): {
  rejectedTokens: number;
  verifySteps: number;
  acceptanceRate: number | null;
} | null {
  if (!before.present && !after.present) return null;
  const rejected = clamp(after.rejectedTokens - before.rejectedTokens);
  const verify = clamp(after.verifySteps - before.verifySteps);
  return {
    rejectedTokens: rejected,
    verifySteps: verify,
    // acceptanceRate cannot be derived from these two counters alone —
    // the caller composes it with the existing `n_drafted_total` /
    // `n_drafted_accepted_total` deltas. We surface it as `null` here so
    // the caller knows to fill it in.
    acceptanceRate: null,
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value;
}

/**
 * Fetch `/metrics` from a running llama-server and pull the two L1
 * counters. Returns `{present: false}` on any HTTP error so a stock
 * build (or a transient blip) does not throw inside the per-turn hot
 * path.
 */
export async function fetchDflashVerifyMetricSample(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<DflashVerifyMetricSample> {
  const empty: DflashVerifyMetricSample = {
    rejectedTokens: 0,
    verifySteps: 0,
    present: false,
  };
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/metrics`, {
      method: "GET",
      signal,
    });
    if (!res.ok) return empty;
    const body = await res.text();
    return parseDflashVerifyMetrics(body);
  } catch {
    return empty;
  }
}
