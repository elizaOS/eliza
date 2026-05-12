import { describe, expect, it } from "vitest";
import type { DflashStreamEvent } from "./dflash-event-schema";
import {
  DflashMetricsCollector,
  type DflashTurnSummary,
  DflashTurnHistory,
} from "./dflash-metrics-collector";

/**
 * Tests author legacy turn summaries with only the legacy fields; this
 * helper fills in zeroed native-discriminator fields so each literal
 * type-checks without restating defaults at every callsite.
 */
function legacySummary(
  partial: Pick<
    DflashTurnSummary,
    | "drafted"
    | "accepted"
    | "rounds"
    | "acceptanceRate"
    | "durationMs"
    | "eventCount"
  >,
): DflashTurnSummary {
  return {
    ...partial,
    nativeEventCount: 0,
    nativeAcceptBatches: 0,
    nativeDrafted: 0,
    nativeAccepted: 0,
    verifyTimeMs: null,
    proposalTimeMs: null,
  };
}

function syntheticTurn(
  acceptedPerEvent: readonly [number, number][],
): DflashStreamEvent[] {
  const out: DflashStreamEvent[] = [
    { kind: "speculate-start", round: 0, ts: 0 },
  ];
  let ts = 1;
  for (const [drafted, accepted] of acceptedPerEvent) {
    out.push({
      kind: "accept",
      drafted: Array.from({ length: drafted }, (_, i) => i),
      accepted: Array.from({ length: accepted }, (_, i) => i),
      ts: ts++,
    });
  }
  out.push({
    kind: "speculate-end",
    round: 0,
    totalDrafted: acceptedPerEvent.reduce((s, [d]) => s + d, 0),
    totalAccepted: acceptedPerEvent.reduce((s, [, a]) => s + a, 0),
    ts: ts,
  });
  return out;
}

describe("DflashMetricsCollector", () => {
  it("accumulates drafted/accepted across events", () => {
    const collector = new DflashMetricsCollector();
    for (const ev of syntheticTurn([
      [4, 3],
      [4, 2],
    ])) {
      collector.record(ev);
    }
    const peek = collector.peek();
    expect(peek.drafted).toBe(8);
    expect(peek.accepted).toBe(5);
    expect(peek.rounds).toBe(1);
    expect(peek.acceptanceRate).toBeCloseTo(5 / 8);
    const summary = collector.finalize();
    expect(summary.drafted).toBe(8);
    expect(summary.accepted).toBe(5);
    expect(summary.eventCount).toBeGreaterThan(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("ignores events recorded after finalize", () => {
    const collector = new DflashMetricsCollector();
    collector.record({
      kind: "accept",
      drafted: [1, 2],
      accepted: [1, 2],
      ts: 0,
    });
    const summary = collector.finalize();
    collector.record({
      kind: "accept",
      drafted: [3, 4, 5],
      accepted: [3],
      ts: 1,
    });
    expect(summary.drafted).toBe(2);
    expect(summary.accepted).toBe(2);
    expect(collector.peek().drafted).toBe(2);
  });
});

describe("DflashMetricsCollector — native vs synthesized discrimination", () => {
  it("counts native-flagged events separately and buckets verify-time quantiles", () => {
    const collector = new DflashMetricsCollector();
    // One synthesized accept (no nativeEvent flag)
    collector.record({
      kind: "accept",
      drafted: [1, 2],
      accepted: [1, 2],
      ts: 0,
    });
    // Two native batches with explicit timing
    collector.record({
      kind: "accept",
      drafted: [3, 4, 5],
      accepted: [3, 4, 5],
      ts: 1,
      nativeEvent: true,
      timing: { proposalMs: 1.0, verifyMs: 4.0 },
    });
    collector.record({
      kind: "accept",
      drafted: [6, 7, 8],
      accepted: [6, 7],
      ts: 2,
      nativeEvent: true,
      timing: { proposalMs: 1.5, verifyMs: 6.0 },
    });
    const summary = collector.finalize();
    expect(summary.eventCount).toBe(3);
    expect(summary.nativeEventCount).toBe(2);
    expect(summary.nativeAcceptBatches).toBe(2);
    expect(summary.nativeDrafted).toBe(6);
    expect(summary.nativeAccepted).toBe(5);
    // Across drafted=8, accepted=7 → overall acceptance rate 7/8
    expect(summary.acceptanceRate).toBeCloseTo(7 / 8);
    expect(summary.verifyTimeMs?.count).toBe(2);
    expect(summary.verifyTimeMs?.p50).toBeCloseTo(5.0); // midpoint of 4,6
    expect(summary.proposalTimeMs?.p50).toBeCloseTo(1.25);
  });

  it("reports null quantiles when no native batch landed", () => {
    const collector = new DflashMetricsCollector();
    collector.record({ kind: "accept", drafted: [1], accepted: [1], ts: 0 });
    const summary = collector.finalize();
    expect(summary.nativeEventCount).toBe(0);
    expect(summary.verifyTimeMs).toBeNull();
    expect(summary.proposalTimeMs).toBeNull();
  });
});

describe("DflashTurnHistory", () => {
  it("rolls over to keep at most `limit` entries", async () => {
    const history = new DflashTurnHistory(3);
    for (let i = 0; i < 5; i += 1) {
      await history.push(
        legacySummary({
          drafted: 10,
          accepted: i,
          rounds: 1,
          acceptanceRate: i / 10,
          durationMs: 0,
          eventCount: 1,
        }),
      );
    }
    expect(history.size()).toBe(3);
    const snap = history.snapshot();
    expect(snap.map((s) => s.accepted)).toEqual([2, 3, 4]);
  });

  it("computes p50/p95 over the rolling window", async () => {
    const history = new DflashTurnHistory(8);
    for (let i = 1; i <= 5; i += 1) {
      await history.push(
        legacySummary({
          drafted: 10,
          accepted: i * 2,
          rounds: 1,
          // Acceptance rates: 0.2, 0.4, 0.6, 0.8, 1.0
          acceptanceRate: (i * 2) / 10,
          durationMs: 0,
          eventCount: 1,
        }),
      );
    }
    const q = history.acceptanceQuantiles();
    expect(q).not.toBeNull();
    expect(q?.samples).toBe(5);
    expect(q?.p50).toBeCloseTo(0.6);
    // p95 across 5 samples: interpolated near max
    expect(q?.p95).toBeGreaterThan(0.9);
  });

  it("returns null quantiles when every turn drafted zero", async () => {
    const history = new DflashTurnHistory();
    await history.push(
      legacySummary({
        drafted: 0,
        accepted: 0,
        rounds: 0,
        acceptanceRate: 0,
        durationMs: 0,
        eventCount: 0,
      }),
    );
    expect(history.acceptanceQuantiles()).toBeNull();
  });

  it("notifies registered listeners on push", async () => {
    const history = new DflashTurnHistory();
    const seen: number[] = [];
    const off = history.addListener((s) => {
      seen.push(s.accepted);
    });
    await history.push(
      legacySummary({
        drafted: 5,
        accepted: 4,
        rounds: 1,
        acceptanceRate: 0.8,
        durationMs: 0,
        eventCount: 1,
      }),
    );
    off();
    await history.push(
      legacySummary({
        drafted: 5,
        accepted: 1,
        rounds: 1,
        acceptanceRate: 0.2,
        durationMs: 0,
        eventCount: 1,
      }),
    );
    expect(seen).toEqual([4]);
  });

  it("aggregates verify-time quantiles across the rolling window", async () => {
    const history = new DflashTurnHistory();
    await history.push({
      drafted: 6,
      accepted: 5,
      rounds: 1,
      acceptanceRate: 5 / 6,
      durationMs: 0,
      eventCount: 2,
      nativeEventCount: 2,
      nativeAcceptBatches: 2,
      nativeDrafted: 6,
      nativeAccepted: 5,
      verifyTimeMs: { p50: 5, p95: 6, count: 2 },
      proposalTimeMs: { p50: 1, p95: 1.5, count: 2 },
    });
    await history.push({
      drafted: 4,
      accepted: 3,
      rounds: 1,
      acceptanceRate: 0.75,
      durationMs: 0,
      eventCount: 1,
      nativeEventCount: 1,
      nativeAcceptBatches: 1,
      nativeDrafted: 4,
      nativeAccepted: 3,
      verifyTimeMs: { p50: 8, p95: 8, count: 1 },
      proposalTimeMs: null,
    });
    const q = history.verifyTimeQuantiles();
    expect(q).not.toBeNull();
    expect(q?.samples).toBe(3);
    expect(q?.p50).toBeGreaterThanOrEqual(5);
    expect(q?.p95).toBeGreaterThanOrEqual(5);
  });

  it("rejects non-positive limits", () => {
    expect(() => new DflashTurnHistory(0)).toThrow();
    expect(() => new DflashTurnHistory(-1)).toThrow();
  });
});
