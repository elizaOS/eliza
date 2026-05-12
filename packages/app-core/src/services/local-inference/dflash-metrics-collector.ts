/**
 * Per-turn DFlash native-event accumulator.
 *
 * Each completion in `dflash-server.ts` opens one collector; every native
 * `DflashStreamEvent` arriving on the SSE stream is appended. On turn-end
 * the collector returns a stats summary, logs the summary, and feeds an
 * optional callback (used by the voice-bench harness). A rolling window
 * of recent turn summaries supports p50/p95 autotune feedback so the
 * tuner can react to drift without a separate metrics store.
 *
 * The whole module is feature-flagged off by default. When the C side
 * does not advertise `capabilities.dflashNativeEvents`, no events are
 * recorded and the collector returns zeroed stats — the legacy synthesized
 * accept-only stream is what runs in production.
 */

import { logger } from "@elizaos/core";
import {
  type DflashStreamEvent,
  type DflashTurnStats,
  type DflashVerifyStreamEvent,
  summarizeEvents,
} from "./dflash-event-schema";

const DEFAULT_HISTORY_LIMIT = 64;
/** Rolling-window size for the per-step acceptance rate (Step 3). */
const VERIFY_ACCEPTANCE_WINDOW = 50;

export interface DflashTurnSummary extends DflashTurnStats {
  /** ms — wall time from collector open to close. */
  durationMs: number;
  /** Event count actually observed (zero when native events were off). */
  eventCount: number;
  /**
   * Count of events whose `nativeEvent === true` — i.e. parsed from the
   * C-side verifier-batch wire shape. The remainder
   * (`eventCount - nativeEventCount`) came from the legacy decision shape
   * or were synthesized locally. Used to verify the native pipeline is
   * actually firing in smoke tests and the autotuner.
   */
  nativeEventCount: number;
  /**
   * Count of native `accept` events (one per verifier batch). Zero when
   * the native protocol is inactive.
   */
  nativeAcceptBatches: number;
  /**
   * Tokens proposed by the drafter, summed across native batches only.
   * Disambiguates from `drafted` (which counts every accept event,
   * native or synthesized).
   */
  nativeDrafted: number;
  /** Tokens the verifier accepted, summed across native batches only. */
  nativeAccepted: number;
  /**
   * Native-batch verify-time quantiles in ms over THIS turn. Null when
   * no native batches landed. Used by the autotuner to spot drafter
   * latency drift.
   */
  verifyTimeMs: { p50: number; p95: number; count: number } | null;
  /**
   * Native-batch proposal-time quantiles in ms over THIS turn. Null
   * when no native batches landed.
   */
  proposalTimeMs: { p50: number; p95: number; count: number } | null;
}

export type DflashTurnSummaryCallback = (
  summary: DflashTurnSummary,
) => void | Promise<void>;

export class DflashMetricsCollector {
  private readonly events: DflashStreamEvent[] = [];
  private readonly startedAt = performance.now();
  private finalized = false;
  /**
   * Per-event source label. Indexed parallel to `events`. `"native"` for
   * events parsed from the C-side verifier-batch wire shape, `"legacy"`
   * for everything else.
   */
  private readonly sources: ("native" | "legacy")[] = [];
  private readonly verifyTimesMs: number[] = [];
  private readonly proposalTimesMs: number[] = [];

  // -------------------------------------------------------------------------
  // L1 — dflash-verify event counters (Step 3)
  // -------------------------------------------------------------------------

  /** Total tokens proposed by the drafter across all verify events. */
  private draftedTokensTotal = 0;
  /** Total tokens accepted by the verifier across all verify events. */
  private acceptedTokensTotal = 0;
  /** Total tokens rejected by the verifier across all verify events. */
  private rejectedTokensTotal = 0;
  /**
   * Circular buffer of per-step acceptance ratios (accept_count /
   * drafted_count) for the rolling 50-event window. Stored as a fixed-size
   * array with a write cursor; NaN entries indicate unfilled slots.
   */
  private readonly acceptanceWindow: number[] = new Array(
    VERIFY_ACCEPTANCE_WINDOW,
  ).fill(Number.NaN);
  private acceptanceWindowCursor = 0;
  private acceptanceWindowFilled = 0;

  record(event: DflashStreamEvent): void {
    if (this.finalized) return;
    this.events.push(event);

    // L1 — handle dflash-verify events for totals + rolling acceptance rate
    if (event.kind === "dflash-verify") {
      this.draftedTokensTotal += event.drafted_count;
      this.acceptedTokensTotal += event.accept_count;
      this.rejectedTokensTotal += event.drafted_count - event.accept_count;
      const stepRate =
        event.drafted_count > 0
          ? event.accept_count / event.drafted_count
          : 1.0;
      this.acceptanceWindow[this.acceptanceWindowCursor] = stepRate;
      this.acceptanceWindowCursor =
        (this.acceptanceWindowCursor + 1) % VERIFY_ACCEPTANCE_WINDOW;
      if (this.acceptanceWindowFilled < VERIFY_ACCEPTANCE_WINDOW) {
        this.acceptanceWindowFilled += 1;
      }
    }

    // Native discriminator: only the verifier-batch parser sets this flag.
    // accept/reject events from the legacy decision parser leave it
    // undefined, so the cast-and-check below is safe.
    const hasNativeFlag =
      (event as { nativeEvent?: boolean }).nativeEvent === true;
    this.sources.push(hasNativeFlag ? "native" : "legacy");
    if (hasNativeFlag) {
      const timing = (
        event as { timing?: { verifyMs?: number; proposalMs?: number } }
      ).timing;
      if (timing) {
        if (
          typeof timing.verifyMs === "number" &&
          Number.isFinite(timing.verifyMs)
        ) {
          this.verifyTimesMs.push(timing.verifyMs);
        }
        if (
          typeof timing.proposalMs === "number" &&
          Number.isFinite(timing.proposalMs)
        ) {
          this.proposalTimesMs.push(timing.proposalMs);
        }
      }
    }
  }

  /**
   * Rolling acceptance rate over the last ≤50 `dflash-verify` steps.
   * Returns `NaN` when no `dflash-verify` events have been recorded yet.
   */
  getAcceptanceRate(): number {
    if (this.acceptanceWindowFilled === 0) return Number.NaN;
    let sum = 0;
    for (let i = 0; i < this.acceptanceWindowFilled; i += 1) {
      const idx =
        (this.acceptanceWindowCursor -
          this.acceptanceWindowFilled +
          i +
          VERIFY_ACCEPTANCE_WINDOW) %
        VERIFY_ACCEPTANCE_WINDOW;
      sum += this.acceptanceWindow[idx];
    }
    return sum / this.acceptanceWindowFilled;
  }

  /**
   * Cumulative draft/accept/reject token totals derived from all
   * `dflash-verify` events recorded so far.
   */
  getDraftAcceptRejectTotals(): {
    drafted: number;
    accepted: number;
    rejected: number;
  } {
    return {
      drafted: this.draftedTokensTotal,
      accepted: this.acceptedTokensTotal,
      rejected: this.rejectedTokensTotal,
    };
  }

  /**
   * Prometheus-text lines for the L1 verify counters. Appended to the
   * llama-server `/metrics` scrape by `DflashServer.scrapeMetrics()` when
   * `useNativeDflashEvents` is active.
   *
   * Returns an empty string when no `dflash-verify` events have landed so
   * the scrape page stays clean for stock builds.
   */
  formatPrometheusMetrics(): string {
    if (this.draftedTokensTotal === 0 && this.acceptanceWindowFilled === 0) {
      return "";
    }
    const rate = this.getAcceptanceRate();
    const rateStr = Number.isNaN(rate) ? "NaN" : rate.toFixed(6);
    return [
      `dflash_drafted_tokens_total ${this.draftedTokensTotal}`,
      `dflash_accepted_tokens_total ${this.acceptedTokensTotal}`,
      `dflash_rejected_tokens_total ${this.rejectedTokensTotal}`,
      `dflash_acceptance_rate ${rateStr}`,
    ].join("\n");
  }

  /** Snapshot stats without finalizing — safe to call mid-turn. */
  peek(): DflashTurnStats {
    return summarizeEvents(this.events);
  }

  finalize(): DflashTurnSummary {
    this.finalized = true;
    const stats = summarizeEvents(this.events);
    let nativeEventCount = 0;
    let nativeAcceptBatches = 0;
    let nativeDrafted = 0;
    let nativeAccepted = 0;
    for (let i = 0; i < this.events.length; i += 1) {
      if (this.sources[i] !== "native") continue;
      nativeEventCount += 1;
      const ev = this.events[i];
      if (ev.kind === "accept") {
        nativeAcceptBatches += 1;
        nativeDrafted += ev.drafted.length;
        nativeAccepted += ev.accepted.length;
      }
    }
    return {
      ...stats,
      durationMs: performance.now() - this.startedAt,
      eventCount: this.events.length,
      nativeEventCount,
      nativeAcceptBatches,
      nativeDrafted,
      nativeAccepted,
      verifyTimeMs: quantilesOf(this.verifyTimesMs),
      proposalTimeMs: quantilesOf(this.proposalTimesMs),
    };
  }
}

/**
 * Compute p50/p95 over a flat numeric series; null when empty.
 * Module-private — the public surface is just on `DflashTurnSummary`.
 */
function quantilesOf(
  samples: readonly number[],
): { p50: number; p95: number; count: number } | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    count: sorted.length,
  };
}

/**
 * Process-wide rolling history of finalized turn summaries. The voice
 * autotuner reads p50/p95 acceptance rate over the last N turns to decide
 * whether to grow/shrink `draftMax`.
 */
export class DflashTurnHistory {
  private readonly buffer: DflashTurnSummary[] = [];
  private readonly limit: number;
  private readonly listeners = new Set<DflashTurnSummaryCallback>();

  constructor(limit: number = DEFAULT_HISTORY_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        `[dflash] DflashTurnHistory limit must be a positive integer, got ${limit}`,
      );
    }
    this.limit = limit;
  }

  /** Add a finalized summary; fires listeners and logs the result. */
  async push(summary: DflashTurnSummary): Promise<void> {
    this.buffer.push(summary);
    if (this.buffer.length > this.limit) this.buffer.shift();
    const verifyTail = summary.verifyTimeMs
      ? ` verifyMsP50=${summary.verifyTimeMs.p50.toFixed(2)} verifyMsP95=${summary.verifyTimeMs.p95.toFixed(2)} nativeBatches=${summary.nativeAcceptBatches}`
      : "";
    logger.info(
      `[DflashMetricsCollector] turn summary drafted=${summary.drafted} accepted=${summary.accepted} rounds=${summary.rounds} acceptanceRate=${summary.acceptanceRate.toFixed(4)} events=${summary.eventCount} native=${summary.nativeEventCount}/${summary.eventCount} durationMs=${Math.round(summary.durationMs)}${verifyTail}`,
    );
    for (const listener of this.listeners) {
      await listener(summary);
    }
  }

  /**
   * Aggregate native verify-time quantiles across every summary in the
   * rolling window. Returns null when no summary in the window observed
   * a native batch (so the autotuner can fall back to legacy heuristics).
   *
   * We don't store the raw samples — only per-turn p50/p95/count — so the
   * aggregate is approximate: each turn's p50 is replicated `count` times
   * into the global series. For the autotuner's drift-detection use case
   * this is exact within ±1 sample at typical turn sizes (≤16 batches).
   */
  verifyTimeQuantiles(): {
    p50: number;
    p95: number;
    samples: number;
  } | null {
    const all: number[] = [];
    for (const s of this.buffer) {
      if (!s.verifyTimeMs) continue;
      for (let i = 0; i < s.verifyTimeMs.count; i += 1) {
        all.push(s.verifyTimeMs.p50);
      }
    }
    if (all.length === 0) return null;
    all.sort((a, b) => a - b);
    return {
      p50: quantile(all, 0.5),
      p95: quantile(all, 0.95),
      samples: all.length,
    };
  }

  size(): number {
    return this.buffer.length;
  }

  snapshot(): readonly DflashTurnSummary[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer.length = 0;
  }

  /**
   * Acceptance-rate quantiles across the rolling window. Returns null when
   * the window has zero meaningful samples (every turn drafted zero
   * tokens, which makes the rate undefined and unsafe to feed the tuner).
   */
  acceptanceQuantiles(): { p50: number; p95: number; samples: number } | null {
    const samples = this.buffer
      .filter((s) => s.drafted > 0)
      .map((s) => s.acceptanceRate)
      .sort((a, b) => a - b);
    if (samples.length === 0) return null;
    return {
      p50: quantile(samples, 0.5),
      p95: quantile(samples, 0.95),
      samples: samples.length,
    };
  }

  /** Register a callback that fires for every finalized turn summary. */
  addListener(listener: DflashTurnSummaryCallback): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function quantile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

/** Module-level singleton, shared by every backend instance. */
export const dflashTurnHistory = new DflashTurnHistory();
