/**
 * Native DFlash speculative-decoding event protocol.
 *
 * The legacy stream synthesizes `accept` events from each SSE text chunk, so
 * the JS side never sees the true drafter/verifier ratio or the exact token
 * indices that were rejected. The native protocol attaches a `dflash` field
 * to each SSE chunk so the JS side can observe real draft batches, accept
 * masks, reject ranges, and speculation round boundaries.
 *
 * See `docs/dflash-native-events-protocol.md` for the wire format and the
 * C-side reference implementation sketch. This file owns the TypeScript
 * representation, runtime validators, and accumulator helpers.
 *
 * Two wire shapes are recognised on the SSE stream — both additive and
 * translated into the same `DflashStreamEvent` discriminated union:
 *
 *  1. The original "decision" shape: `{kind:"accept"|"reject"|"speculate-*"}`
 *     embedded under `dflash`.
 *  2. The "verifier-batch" shape: the fork emits, after each verifier
 *     batch,
 *     ```json
 *     {"type":"dflash_event",
 *      "draft_tokens":[...],"accept_count":N,
 *      "reject_range":[s,e]|null,"accept_tokens":[...],
 *      "timing":{"proposal_ms":X,"verify_ms":Y}}
 *     ```
 *     under the top-level `dflash` field. Parsed via `dflashBatchEventSchema`
 *     (Zod) and translated into one `accept` event (always) plus one
 *     `reject` event (when `reject_range != null`). The parsed events are
 *     flagged with `nativeEvent: true` and carry per-batch `timing` so the
 *     metrics collector can count native vs synthesized batches and
 *     bucket verify-time p50/p95.
 *
 * The protocol is additive — clients that do not read these fields keep
 * working unchanged, and the feature is opt-in via
 * `optimizations.nativeDflashEvents` on each catalog bundle plus a runtime
 * `/health` capability probe.
 */
import { z } from "zod";

/**
 * Per-verifier-batch timing the C-side records and emits on the batch
 * event. `proposalMs` is wall time spent in the drafter loop for the
 * proposal; `verifyMs` is wall time spent in the verifier forward pass.
 */
export interface DflashBatchTiming {
  proposalMs: number;
  verifyMs: number;
}

/**
 * One accepted draft batch: the drafter proposed `drafted` token ids; the
 * verifier accepted the prefix `accepted` (which is always a prefix of
 * `drafted`). Empty `accepted` means everything was rejected.
 *
 * `nativeEvent` is `true` for events parsed from the C-side
 * "verifier-batch" wire shape (`type:"dflash_event"`). Events parsed from
 * the original `kind:"accept"` decision shape leave it `undefined` —
 * downstream code treats undefined as "not native". The metrics collector
 * uses this discriminator to bucket native vs synthesized counts.
 */
export interface DflashAcceptEvent {
  kind: "accept";
  drafted: readonly number[];
  accepted: readonly number[];
  /** Server monotonic timestamp in ms. */
  ts: number;
  /** True when parsed from the native `type:"dflash_event"` wire shape. */
  nativeEvent?: true;
  /** Per-batch timing; populated only when `nativeEvent` is true. */
  timing?: DflashBatchTiming;
}

/**
 * The verifier rejected a contiguous span [from, to] of previously-streamed
 * drafted tokens, and replaced position `from` with `correctedToken`.
 * Indices are in target output order and inclusive on both ends.
 *
 * See `DflashAcceptEvent` for the `nativeEvent` / `timing` discriminator.
 */
export interface DflashRejectEvent {
  kind: "reject";
  drafted: readonly number[];
  rejectRange: readonly [number, number];
  correctedToken: number;
  ts: number;
  /** True when parsed from the native `type:"dflash_event"` wire shape. */
  nativeEvent?: true;
  /** Per-batch timing; populated only when `nativeEvent` is true. */
  timing?: DflashBatchTiming;
}

/** A new speculation round began (drafter starts drafting a fresh batch). */
export interface DflashSpeculateStartEvent {
  kind: "speculate-start";
  round: number;
  ts: number;
}

/** A speculation round ended; carries the running totals for the round. */
export interface DflashSpeculateEndEvent {
  kind: "speculate-end";
  round: number;
  totalDrafted: number;
  totalAccepted: number;
  ts: number;
}

/**
 * L1 — per-step verify summary emitted by the native C-side DFlash
 * engine. One of these arrives per speculative-decoding verify step, on
 * the `dflash` SSE field alongside (or instead of) the batch-event
 * shape. Fired only when `ELIZA_NATIVE_DFLASH_EVENTS=1` is set on the
 * server side (TypeScript feature-flag: `useNativeDflashEvents`).
 *
 * Fields match the wire format in `docs/eliza-1-dflash-events-wire.md`:
 *   - `drafted_count` — tokens the drafter proposed in this step.
 *   - `accept_count`  — tokens the verifier accepted (≤ drafted_count).
 *   - `reject_index`  — index within the drafted sequence where the
 *                       first rejection occurred (-1 when all accepted).
 *   - `correction_token_id` — token id emitted by the verifier at the
 *                             rejection point; null when all accepted.
 *   - `verify_latency_ms` — wall-clock ms from drafter proposal start
 *                           to verifier accept/reject decision.
 */
export interface DflashVerifyStreamEvent {
  kind: "dflash-verify";
  /** Number of tokens the drafter proposed in this step. */
  drafted_count: number;
  /** Number of tokens accepted by the verifier. */
  accept_count: number;
  /** Index within the drafted sequence where the first rejection occurred (-1 = all accepted). */
  reject_index: number;
  /** The correction token id emitted by the verifier at the rejection point (null when all accepted). */
  correction_token_id: number | null;
  /** Wall-clock ms from drafter proposal start to verifier accept/reject decision. */
  verify_latency_ms: number;
}

export type DflashStreamEvent =
  | DflashAcceptEvent
  | DflashRejectEvent
  | DflashSpeculateStartEvent
  | DflashSpeculateEndEvent
  | DflashVerifyStreamEvent;

export type DflashStreamEventKind = DflashStreamEvent["kind"];

// ---------------------------------------------------------------------------
// Runtime validators. Hand-written (no zod dep here) — the discriminated
// union is small and the parsers run per SSE chunk in a hot path.
// ---------------------------------------------------------------------------

function isNonNegativeIntArray(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false;
  for (const v of value) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return false;
  }
  return true;
}

function isInclusiveRange(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isInteger(value[0]) &&
    Number.isInteger(value[1]) &&
    value[0] >= 0 &&
    value[1] >= value[0]
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Parse a JSON value into a `DflashStreamEvent`. Returns null on any shape
 * mismatch — the caller treats parse failures as "no native event present"
 * and falls back to the legacy synthesis path.
 *
 * NOTE: the `dflash-verify` variant does not carry a `ts` field (see the
 * `DflashVerifyStreamEvent` interface); its case is handled before the `ts`
 * guard so callers do not need to inject a synthetic timestamp.
 */
export function parseDflashStreamEvent(raw: unknown): DflashStreamEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;

  // dflash-verify has no ts field — parse it before the ts guard.
  if (kind === "dflash-verify") {
    if (
      !isNonNegativeInt(obj.drafted_count) ||
      !isNonNegativeInt(obj.accept_count)
    ) {
      return null;
    }
    if ((obj.accept_count as number) > (obj.drafted_count as number))
      return null;
    if (
      typeof obj.reject_index !== "number" ||
      !Number.isInteger(obj.reject_index) ||
      obj.reject_index < -1
    ) {
      return null;
    }
    if (obj.correction_token_id !== null) {
      if (!isNonNegativeInt(obj.correction_token_id)) return null;
    }
    if (
      !isFiniteNumber(obj.verify_latency_ms) ||
      (obj.verify_latency_ms as number) < 0
    ) {
      return null;
    }
    return {
      kind: "dflash-verify",
      drafted_count: obj.drafted_count as number,
      accept_count: obj.accept_count as number,
      reject_index: obj.reject_index as number,
      correction_token_id:
        obj.correction_token_id === null
          ? null
          : (obj.correction_token_id as number),
      verify_latency_ms: obj.verify_latency_ms as number,
    };
  }

  const ts = isFiniteNumber(obj.ts) ? obj.ts : null;
  if (ts === null) return null;
  switch (kind) {
    case "accept": {
      if (
        !isNonNegativeIntArray(obj.drafted) ||
        !isNonNegativeIntArray(obj.accepted)
      ) {
        return null;
      }
      // `accepted` must be a prefix of `drafted` by length.
      if (obj.accepted.length > obj.drafted.length) return null;
      return {
        kind: "accept",
        drafted: obj.drafted,
        accepted: obj.accepted,
        ts,
      };
    }
    case "reject": {
      if (
        !isNonNegativeIntArray(obj.drafted) ||
        !isInclusiveRange(obj.rejectRange) ||
        !isNonNegativeInt(obj.correctedToken)
      ) {
        return null;
      }
      return {
        kind: "reject",
        drafted: obj.drafted,
        rejectRange: obj.rejectRange,
        correctedToken: obj.correctedToken,
        ts,
      };
    }
    case "speculate-start": {
      if (!isNonNegativeInt(obj.round)) return null;
      return { kind: "speculate-start", round: obj.round, ts };
    }
    case "speculate-end": {
      if (
        !isNonNegativeInt(obj.round) ||
        !isNonNegativeInt(obj.totalDrafted) ||
        !isNonNegativeInt(obj.totalAccepted)
      ) {
        return null;
      }
      if (obj.totalAccepted > obj.totalDrafted) return null;
      return {
        kind: "speculate-end",
        round: obj.round,
        totalDrafted: obj.totalDrafted,
        totalAccepted: obj.totalAccepted,
        ts,
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Zod schema for the "verifier-batch" wire shape emitted by the
// `--dflash-emit-events` patch in the fork's server.cpp:
//
//   { "type": "dflash_event",
//     "draft_tokens":  [int...],
//     "accept_count":  int,
//     "reject_range":  [int, int] | null,
//     "accept_tokens": [int...],
//     "timing":        { "proposal_ms": number, "verify_ms": number } }
//
// Translation rules (`expandDflashBatchEvent`):
//   - Always produces one `kind: "accept"` event with `drafted=draft_tokens`
//     and `accepted=accept_tokens` (which by protocol is the first
//     `accept_count` ids of `draft_tokens`).
//   - When `reject_range != null`, additionally produces one `kind: "reject"`
//     event with `rejectRange=reject_range`. The `correctedToken` is the
//     last id in `accept_tokens` (the verifier's correction).
//   - Both produced events carry `nativeEvent: true` plus a copy of
//     `timing`. This is the only path that sets those fields.
// ---------------------------------------------------------------------------

const tokenIdSchema = z.number().int().nonnegative();
const millisecondsSchema = z.number().nonnegative().finite();

/** Public Zod schema for the verifier-batch wire shape. Exported for tests. */
export const dflashBatchEventSchema = z.object({
  type: z.literal("dflash_event"),
  draft_tokens: z.array(tokenIdSchema),
  accept_count: z.number().int().nonnegative(),
  reject_range: z
    .union([
      z.tuple([
        z.number().int().nonnegative(),
        z.number().int().nonnegative(),
      ]),
      z.null(),
    ])
    .optional()
    .default(null),
  accept_tokens: z.array(tokenIdSchema),
  timing: z.object({
    proposal_ms: millisecondsSchema,
    verify_ms: millisecondsSchema,
  }),
  /** Server monotonic timestamp in ms. Optional — defaults to 0 if absent. */
  ts: z.number().finite().optional(),
});

export type DflashBatchEvent = z.infer<typeof dflashBatchEventSchema>;

/**
 * Canonical Zod schema for the native DFlash verifier-batch wire shape as
 * described in the task spec. Adds the `native: true` discriminator field so
 * downstream consumers can narrow the type without inspecting `type`. This is
 * a strict superset of `dflashBatchEventSchema`; existing code that uses the
 * latter is unaffected.
 *
 * Wire shape (emitted by the C-side `--dflash-emit-events` patch):
 * ```json
 * { "type": "dflash_event", "native": true,
 *   "draft_tokens": [...], "accept_count": N,
 *   "reject_range": [s, e] | null, "accept_tokens": [...],
 *   "timing": { "proposal_ms": X, "verify_ms": Y } }
 * ```
 */
export const DFlashNativeEventSchema = z.object({
  type: z.literal("dflash_event"),
  native: z.literal(true),
  draft_tokens: z.array(z.number().int()),
  accept_count: z.number().int().nonnegative(),
  reject_range: z.tuple([z.number().int(), z.number().int()]).nullable(),
  accept_tokens: z.array(z.number().int()),
  timing: z.object({ proposal_ms: z.number(), verify_ms: z.number() }),
});

export type DFlashNativeEvent = z.infer<typeof DFlashNativeEventSchema>;

/**
 * Translate one parsed verifier-batch event into the discriminated-union
 * representation. Returns an empty array when the batch is structurally
 * inconsistent (e.g. `accept_count !== accept_tokens.length`) rather than
 * throwing; the caller treats parse failures as "no native event present"
 * and falls back to the legacy synthesis path.
 */
export function expandDflashBatchEvent(
  batch: DflashBatchEvent,
): DflashStreamEvent[] {
  const ts = typeof batch.ts === "number" ? batch.ts : 0;
  const drafted = batch.draft_tokens;
  const accepted = batch.accept_tokens;
  // Invariants per protocol: accept_count == accept_tokens.length and
  // accept_tokens is the `accept_count` prefix of draft_tokens. We tolerate
  // either invariant being slightly off (caller-side bugs in the C fork are
  // common during transition merges) by trusting `accept_tokens` for the
  // accepted list but rejecting the whole batch when accept_count clearly
  // disagrees with the protocol.
  if (batch.accept_count !== accepted.length) return [];
  if (accepted.length > drafted.length) return [];
  const timing: DflashBatchTiming = {
    proposalMs: batch.timing.proposal_ms,
    verifyMs: batch.timing.verify_ms,
  };
  const events: DflashStreamEvent[] = [];
  const acceptEvent: DflashAcceptEvent = {
    kind: "accept",
    drafted,
    accepted,
    ts,
    nativeEvent: true,
    timing,
  };
  events.push(acceptEvent);
  const range = batch.reject_range ?? null;
  if (range && range[1] >= range[0] && range[0] >= 0) {
    // Corrected token: the last id in `accept_tokens` (the verifier's
    // bonus / correction). When accept_tokens is empty, the verifier did
    // not yet emit a correction in this batch — drop the reject event
    // rather than guessing.
    const correctedToken =
      accepted.length > 0 ? accepted[accepted.length - 1] : null;
    if (correctedToken !== null) {
      const rejectEvent: DflashRejectEvent = {
        kind: "reject",
        drafted,
        rejectRange: [range[0], range[1]],
        correctedToken,
        ts,
        nativeEvent: true,
        timing,
      };
      events.push(rejectEvent);
    }
  }
  return events;
}

/**
 * Parse a single SSE-chunk field value as a verifier-batch event. Returns
 * the expanded `DflashStreamEvent[]` on success, `null` when the value is
 * not the verifier-batch shape (caller should try the legacy parser
 * instead), or `[]` on shape mismatch within the verifier-batch path
 * (caller does NOT fall back to legacy for the same entry).
 */
export function parseDflashBatchEvent(
  raw: unknown,
): DflashStreamEvent[] | null {
  if (!raw || typeof raw !== "object") return null;
  // Cheap discriminator probe: only run the Zod parse when the `type`
  // tag matches. Avoids paying the schema cost on every legacy event.
  if ((raw as Record<string, unknown>).type !== "dflash_event") return null;
  const result = dflashBatchEventSchema.safeParse(raw);
  if (!result.success) return [];
  return expandDflashBatchEvent(result.data);
}

/**
 * Parse the optional `dflash` field on an SSE chunk. The native protocol
 * carries either a single event or an array of events on a single chunk
 * (e.g. `speculate-start` + `accept` co-emitted). Returns `[]` when the
 * field is absent or malformed.
 *
 * Each entry is tried first against the verifier-batch shape (Zod), then
 * against the legacy discriminated-union shape. The first parser that
 * recognises the entry wins; failures from a recognised parser drop the
 * entry rather than spilling into the other (so a malformed batch does
 * not silently fall back to legacy synthesis).
 */
export function parseDflashFieldFromSseChunk(
  parsed: unknown,
): DflashStreamEvent[] {
  if (!parsed || typeof parsed !== "object") return [];
  const field = (parsed as Record<string, unknown>).dflash;
  if (field === undefined || field === null) return [];
  const out: DflashStreamEvent[] = [];
  const pushEntry = (entry: unknown): void => {
    const batch = parseDflashBatchEvent(entry);
    if (batch !== null) {
      for (const ev of batch) out.push(ev);
      return;
    }
    const ev = parseDflashStreamEvent(entry);
    if (ev) out.push(ev);
  };
  if (Array.isArray(field)) {
    for (const entry of field) pushEntry(entry);
    return out;
  }
  pushEntry(field);
  return out;
}

// ---------------------------------------------------------------------------
// Compute helpers
// ---------------------------------------------------------------------------

/**
 * Compute the cumulative acceptance rate (accepted / drafted) across all
 * `accept` events in the stream. Reject events do not count as either
 * drafted or accepted here — they describe out-of-band corrections that
 * the C side has already accounted for in its own counters. Returns 0
 * when no tokens were drafted.
 */
export function computeAcceptanceRate(
  events: readonly DflashStreamEvent[],
): number {
  let drafted = 0;
  let accepted = 0;
  for (const event of events) {
    if (event.kind === "accept") {
      drafted += event.drafted.length;
      accepted += event.accepted.length;
    }
  }
  if (drafted === 0) return 0;
  return accepted / drafted;
}

/**
 * One speculation round's view of the stream. Bounded by a
 * `speculate-start` / `speculate-end` pair where present, otherwise the
 * events between consecutive `speculate-start` markers. Events that arrive
 * before the first `speculate-start` go into a virtual `round = -1`
 * bucket so they are never silently dropped.
 */
export interface DflashRound {
  round: number;
  events: DflashStreamEvent[];
  drafted: number;
  accepted: number;
}

export function groupByRound(
  events: readonly DflashStreamEvent[],
): DflashRound[] {
  const rounds = new Map<number, DflashRound>();
  let currentRound = -1;
  const ensure = (round: number): DflashRound => {
    let bucket = rounds.get(round);
    if (!bucket) {
      bucket = { round, events: [], drafted: 0, accepted: 0 };
      rounds.set(round, bucket);
    }
    return bucket;
  };
  for (const event of events) {
    if (event.kind === "speculate-start") {
      currentRound = event.round;
    }
    const bucket = ensure(currentRound);
    bucket.events.push(event);
    if (event.kind === "accept") {
      bucket.drafted += event.drafted.length;
      bucket.accepted += event.accepted.length;
    }
  }
  return [...rounds.values()].sort((a, b) => a.round - b.round);
}

/**
 * Summary of a turn's native DFlash activity. Returned alongside the
 * generated text from `generateWithUsage` when the native protocol is
 * active so the autotuner and bench harness can read exact counts.
 */
export interface DflashTurnStats {
  drafted: number;
  accepted: number;
  rounds: number;
  acceptanceRate: number;
}

export function summarizeEvents(
  events: readonly DflashStreamEvent[],
): DflashTurnStats {
  let drafted = 0;
  let accepted = 0;
  const roundIds = new Set<number>();
  for (const event of events) {
    if (event.kind === "accept") {
      drafted += event.drafted.length;
      accepted += event.accepted.length;
    } else if (
      event.kind === "speculate-start" ||
      event.kind === "speculate-end"
    ) {
      roundIds.add(event.round);
    }
  }
  return {
    drafted,
    accepted,
    rounds: roundIds.size,
    acceptanceRate: drafted === 0 ? 0 : accepted / drafted,
  };
}
