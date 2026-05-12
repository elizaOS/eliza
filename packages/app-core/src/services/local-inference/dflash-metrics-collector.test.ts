import { describe, expect, it } from "vitest";
import type { DflashStreamEvent } from "./dflash-event-schema";
import {
  DflashMetricsCollector,
  DflashTurnHistory,
} from "./dflash-metrics-collector";

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

describe("DflashTurnHistory", () => {
  it("rolls over to keep at most `limit` entries", async () => {
    const history = new DflashTurnHistory(3);
    for (let i = 0; i < 5; i += 1) {
      await history.push({
        drafted: 10,
        accepted: i,
        rounds: 1,
        acceptanceRate: i / 10,
        durationMs: 0,
        eventCount: 1,
      });
    }
    expect(history.size()).toBe(3);
    const snap = history.snapshot();
    expect(snap.map((s) => s.accepted)).toEqual([2, 3, 4]);
  });

  it("computes p50/p95 over the rolling window", async () => {
    const history = new DflashTurnHistory(8);
    for (let i = 1; i <= 5; i += 1) {
      await history.push({
        drafted: 10,
        accepted: i * 2,
        rounds: 1,
        // Acceptance rates: 0.2, 0.4, 0.6, 0.8, 1.0
        acceptanceRate: (i * 2) / 10,
        durationMs: 0,
        eventCount: 1,
      });
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
    await history.push({
      drafted: 0,
      accepted: 0,
      rounds: 0,
      acceptanceRate: 0,
      durationMs: 0,
      eventCount: 0,
    });
    expect(history.acceptanceQuantiles()).toBeNull();
  });

  it("notifies registered listeners on push", async () => {
    const history = new DflashTurnHistory();
    const seen: number[] = [];
    const off = history.addListener((s) => {
      seen.push(s.accepted);
    });
    await history.push({
      drafted: 5,
      accepted: 4,
      rounds: 1,
      acceptanceRate: 0.8,
      durationMs: 0,
      eventCount: 1,
    });
    off();
    await history.push({
      drafted: 5,
      accepted: 1,
      rounds: 1,
      acceptanceRate: 0.2,
      durationMs: 0,
      eventCount: 1,
    });
    expect(seen).toEqual([4]);
  });

  it("rejects non-positive limits", () => {
    expect(() => new DflashTurnHistory(0)).toThrow();
    expect(() => new DflashTurnHistory(-1)).toThrow();
  });
});
