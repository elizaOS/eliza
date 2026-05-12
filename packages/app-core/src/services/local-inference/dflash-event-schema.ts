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
 * The protocol is additive — clients that do not read the `dflash` field
 * keep working unchanged, and the feature is opt-in via
 * `optimizations.nativeDflashEvents` on each catalog bundle plus a runtime
 * `/health` capability probe.
 */

/**
 * One accepted draft batch: the drafter proposed `drafted` token ids; the
 * verifier accepted the prefix `accepted` (which is always a prefix of
 * `drafted`). Empty `accepted` means everything was rejected.
 */
export interface DflashAcceptEvent {
  kind: "accept";
  drafted: readonly number[];
  accepted: readonly number[];
  /** Server monotonic timestamp in ms. */
  ts: number;
}

/**
 * The verifier rejected a contiguous span [from, to] of previously-streamed
 * drafted tokens, and replaced position `from` with `correctedToken`.
 * Indices are in target output order and inclusive on both ends.
 */
export interface DflashRejectEvent {
  kind: "reject";
  drafted: readonly number[];
  rejectRange: readonly [number, number];
  correctedToken: number;
  ts: number;
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

export type DflashStreamEvent =
  | DflashAcceptEvent
  | DflashRejectEvent
  | DflashSpeculateStartEvent
  | DflashSpeculateEndEvent;

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
 */
export function parseDflashStreamEvent(raw: unknown): DflashStreamEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
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

/**
 * Parse the optional `dflash` field on an SSE chunk. The native protocol
 * carries either a single event or an array of events on a single chunk
 * (e.g. `speculate-start` + `accept` co-emitted). Returns `[]` when the
 * field is absent or malformed.
 */
export function parseDflashFieldFromSseChunk(
  parsed: unknown,
): DflashStreamEvent[] {
  if (!parsed || typeof parsed !== "object") return [];
  const field = (parsed as Record<string, unknown>).dflash;
  if (field === undefined || field === null) return [];
  if (Array.isArray(field)) {
    const out: DflashStreamEvent[] = [];
    for (const entry of field) {
      const ev = parseDflashStreamEvent(entry);
      if (ev) out.push(ev);
    }
    return out;
  }
  const ev = parseDflashStreamEvent(field);
  return ev ? [ev] : [];
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
