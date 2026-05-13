import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  DflashStreamEvent,
  DflashVerifyStreamEvent,
} from "./dflash-event-schema";
import {
  DflashMetricsCollector,
  DflashTurnHistory,
  type DflashTurnSummary,
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

// ---------------------------------------------------------------------------
// L1 — dflash-verify event accumulation (Step 3)
// ---------------------------------------------------------------------------

/** Build a synthetic dflash-verify event. */
function makeVerifyEvent(
  drafted_count: number,
  accept_count: number,
  reject_index: number,
  correction_token_id: number | null,
  verify_latency_ms = 10,
): DflashVerifyStreamEvent {
  return {
    kind: "dflash-verify",
    drafted_count,
    accept_count,
    reject_index,
    correction_token_id,
    verify_latency_ms,
  };
}

describe("DflashMetricsCollector — dflash-verify totals", () => {
  it("accumulates drafted/accepted/rejected totals from verify events", () => {
    const collector = new DflashMetricsCollector();
    // Step 1: 4 drafted, 3 accepted → 1 rejected
    collector.record(makeVerifyEvent(4, 3, 3, 99));
    // Step 2: 5 drafted, 5 accepted → 0 rejected (all accepted)
    collector.record(makeVerifyEvent(5, 5, -1, null));
    // Step 3: 3 drafted, 1 accepted → 2 rejected
    collector.record(makeVerifyEvent(3, 1, 1, 42));

    const totals = collector.getDraftAcceptRejectTotals();
    expect(totals.drafted).toBe(12); // 4+5+3
    expect(totals.accepted).toBe(9); // 3+5+1
    expect(totals.rejected).toBe(3); // 1+0+2
  });

  it("returns zero totals when no verify events recorded", () => {
    const collector = new DflashMetricsCollector();
    // Record a non-verify event — should not affect verify totals.
    collector.record({
      kind: "accept",
      drafted: [1, 2],
      accepted: [1, 2],
      ts: 0,
    });
    const totals = collector.getDraftAcceptRejectTotals();
    expect(totals.drafted).toBe(0);
    expect(totals.accepted).toBe(0);
    expect(totals.rejected).toBe(0);
  });

  it("coexists with legacy accept/reject events without interfering", () => {
    const collector = new DflashMetricsCollector();
    // Legacy accept event
    collector.record({
      kind: "accept",
      drafted: [1, 2, 3],
      accepted: [1, 2, 3],
      ts: 0,
    });
    // Native verify event
    collector.record(makeVerifyEvent(4, 2, 2, 7));
    // Legacy finalize still counts the legacy events
    const summary = collector.finalize();
    expect(summary.drafted).toBe(3); // from legacy accept event
    expect(summary.accepted).toBe(3);
    // Verify totals are separate
    const totals = collector.getDraftAcceptRejectTotals();
    expect(totals.drafted).toBe(4);
    expect(totals.accepted).toBe(2);
    expect(totals.rejected).toBe(2);
  });
});

describe("DflashMetricsCollector — rolling acceptance rate (50-event window)", () => {
  it("returns NaN when no verify events recorded", () => {
    const collector = new DflashMetricsCollector();
    expect(Number.isNaN(collector.getAcceptanceRate())).toBe(true);
  });

  it("returns NaN when only non-verify events recorded", () => {
    const collector = new DflashMetricsCollector();
    collector.record({ kind: "accept", drafted: [1], accepted: [1], ts: 0 });
    expect(Number.isNaN(collector.getAcceptanceRate())).toBe(true);
  });

  it("computes correct rolling rate for a few events", () => {
    const collector = new DflashMetricsCollector();
    // 4 drafted, 4 accepted = 1.0
    collector.record(makeVerifyEvent(4, 4, -1, null));
    // 4 drafted, 2 accepted = 0.5
    collector.record(makeVerifyEvent(4, 2, 2, 9));
    // 4 drafted, 0 accepted = 0.0
    collector.record(makeVerifyEvent(4, 0, 0, 5));
    // Mean of (1.0, 0.5, 0.0) = 0.5
    expect(collector.getAcceptanceRate()).toBeCloseTo(0.5);
  });

  it("caps the window at 50 events (circular buffer behavior)", () => {
    const collector = new DflashMetricsCollector();
    // Fill more than 50 events: first 50 are rate=1.0, then 10 are rate=0.0
    for (let i = 0; i < 50; i += 1) {
      collector.record(makeVerifyEvent(4, 4, -1, null)); // rate = 1.0
    }
    expect(collector.getAcceptanceRate()).toBeCloseTo(1.0);
    for (let i = 0; i < 10; i += 1) {
      collector.record(makeVerifyEvent(4, 0, 0, 1)); // rate = 0.0
    }
    // Window now holds 40 events at 1.0 and 10 events at 0.0 → mean = 40/50 = 0.8
    expect(collector.getAcceptanceRate()).toBeCloseTo(0.8);
  });

  it("handles drafted_count = 0 as rate 1.0 (defensive — no division by zero)", () => {
    const collector = new DflashMetricsCollector();
    // Edge: drafter proposed 0 tokens (should not crash)
    collector.record(makeVerifyEvent(0, 0, -1, null));
    const rate = collector.getAcceptanceRate();
    expect(Number.isNaN(rate)).toBe(false);
    expect(rate).toBeCloseTo(1.0);
  });
});

describe("DflashMetricsCollector — formatPrometheusMetrics", () => {
  it("returns empty string when no verify events recorded", () => {
    const collector = new DflashMetricsCollector();
    expect(collector.formatPrometheusMetrics()).toBe("");
  });

  it("returns empty string when only legacy events recorded", () => {
    const collector = new DflashMetricsCollector();
    collector.record({ kind: "accept", drafted: [1, 2], accepted: [1], ts: 0 });
    expect(collector.formatPrometheusMetrics()).toBe("");
  });

  it("returns Prometheus lines with correct values after verify events", () => {
    const collector = new DflashMetricsCollector();
    collector.record(makeVerifyEvent(4, 3, 3, 99));
    collector.record(makeVerifyEvent(4, 2, 2, 7));

    const text = collector.formatPrometheusMetrics();
    expect(text).toContain("dflash_drafted_tokens_total 8");
    expect(text).toContain("dflash_accepted_tokens_total 5");
    expect(text).toContain("dflash_rejected_tokens_total 3");
    expect(text).toContain("dflash_acceptance_rate ");
    // acceptance rate = mean of (3/4, 2/4) = mean of (0.75, 0.5) = 0.625
    expect(text).toMatch(/dflash_acceptance_rate 0\.6250/);
  });
});

describe("feature flag — useNativeDflashEvents gates dflash-verify events", () => {
  const origEnv = process.env.ELIZA_NATIVE_DFLASH_EVENTS;

  beforeEach(() => {
    delete process.env.ELIZA_NATIVE_DFLASH_EVENTS;
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.ELIZA_NATIVE_DFLASH_EVENTS;
    } else {
      process.env.ELIZA_NATIVE_DFLASH_EVENTS = origEnv;
    }
  });

  it("flag is OFF by default — collector receives no dflash-verify events from a mock server", () => {
    // Simulate the gating logic: when flag is off, we never call record()
    // with a dflash-verify event. The collector should show zero totals.
    const collector = new DflashMetricsCollector();
    const flagOn = process.env.ELIZA_NATIVE_DFLASH_EVENTS === "1";
    expect(flagOn).toBe(false);

    // A downstream mock: only records verify events when flag is on.
    const mockServerOnEvent = (event: DflashStreamEvent) => {
      if (flagOn) collector.record(event);
    };
    mockServerOnEvent(makeVerifyEvent(4, 3, 3, 99));

    const totals = collector.getDraftAcceptRejectTotals();
    expect(totals.drafted).toBe(0);
    expect(totals.accepted).toBe(0);
    expect(totals.rejected).toBe(0);
    expect(Number.isNaN(collector.getAcceptanceRate())).toBe(true);
    expect(collector.formatPrometheusMetrics()).toBe("");
  });

  it("flag is ON — collector receives and accumulates dflash-verify events", () => {
    process.env.ELIZA_NATIVE_DFLASH_EVENTS = "1";
    const collector = new DflashMetricsCollector();
    const flagOn = process.env.ELIZA_NATIVE_DFLASH_EVENTS === "1";
    expect(flagOn).toBe(true);

    const mockServerOnEvent = (event: DflashStreamEvent) => {
      if (flagOn) collector.record(event);
    };
    mockServerOnEvent(makeVerifyEvent(4, 3, 3, 99));
    mockServerOnEvent(makeVerifyEvent(2, 2, -1, null));

    const totals = collector.getDraftAcceptRejectTotals();
    expect(totals.drafted).toBe(6);
    expect(totals.accepted).toBe(5);
    expect(totals.rejected).toBe(1);
    expect(Number.isNaN(collector.getAcceptanceRate())).toBe(false);
    // Prometheus output should be non-empty
    expect(collector.formatPrometheusMetrics()).not.toBe("");
  });
});
