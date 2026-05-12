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
  summarizeEvents,
} from "./dflash-event-schema";

const DEFAULT_HISTORY_LIMIT = 64;

export interface DflashTurnSummary extends DflashTurnStats {
  /** ms — wall time from collector open to close. */
  durationMs: number;
  /** Event count actually observed (zero when native events were off). */
  eventCount: number;
}

export type DflashTurnSummaryCallback = (
  summary: DflashTurnSummary,
) => void | Promise<void>;

export class DflashMetricsCollector {
  private readonly events: DflashStreamEvent[] = [];
  private readonly startedAt = performance.now();
  private finalized = false;

  record(event: DflashStreamEvent): void {
    if (this.finalized) return;
    this.events.push(event);
  }

  /** Snapshot stats without finalizing — safe to call mid-turn. */
  peek(): DflashTurnStats {
    return summarizeEvents(this.events);
  }

  finalize(): DflashTurnSummary {
    this.finalized = true;
    const stats = summarizeEvents(this.events);
    return {
      ...stats,
      durationMs: performance.now() - this.startedAt,
      eventCount: this.events.length,
    };
  }
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
    logger.info(
      `[DflashMetricsCollector] turn summary drafted=${summary.drafted} accepted=${summary.accepted} rounds=${summary.rounds} acceptanceRate=${summary.acceptanceRate.toFixed(4)} events=${summary.eventCount} durationMs=${Math.round(summary.durationMs)}`,
    );
    for (const listener of this.listeners) {
      await listener(summary);
    }
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
