import { describe, it, expect } from "bun:test";
import { MetricsCollector, percentile } from "../metrics.ts";
import type { BenchDriverResult } from "../types.ts";

const STUB_RESULT: BenchDriverResult = {
  exitReason: "done",
  draftTokensTotal: 100,
  draftTokensWasted: 10,
};

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("MetricsCollector", () => {
  it("captures first-observation timestamps per event name", async () => {
    const c = new MetricsCollector({ fixtureId: "t1" });
    c.record("speech-start");
    await waitMs(5);
    c.record("speech-end");
    await waitMs(5);
    c.record("audio-out-first-frame");
    const m = c.finalize(STUB_RESULT);
    expect(m.fixtureId).toBe("t1");
    expect(m.ttfaMs).toBeGreaterThan(0);
    expect(m.speechEndToFirstAudioMs).toBeGreaterThan(0);
    // TTFA must exceed speechEnd→audio.
    expect(m.ttfaMs).toBeGreaterThanOrEqual(m.speechEndToFirstAudioMs);
  });

  it("throws when a required event is missing", () => {
    const c = new MetricsCollector({ fixtureId: "t2" });
    c.record("speech-start");
    c.record("audio-out-first-frame"); // missing speech-end
    expect(() => c.finalize(STUB_RESULT)).toThrow(/speech-end/);
  });

  it("captures barge-in response time when both trigger and hard-stop fire", async () => {
    const c = new MetricsCollector({ fixtureId: "barge" });
    c.record("speech-start");
    c.record("barge-in-trigger");
    await waitMs(10);
    c.record("barge-in-hard-stop");
    c.record("speech-end");
    c.record("audio-out-first-frame");
    const m = c.finalize(STUB_RESULT);
    expect(m.bargeInResponseMs).toBeDefined();
    expect(m.bargeInResponseMs!).toBeGreaterThan(0);
    expect(m.falseBargeInCount).toBe(0);
  });

  it("counts false barge-ins (trigger without hard-stop)", () => {
    const c = new MetricsCollector({ fixtureId: "false-barge" });
    c.record("speech-start");
    c.record("barge-in-trigger");
    c.record("speech-end");
    c.record("audio-out-first-frame");
    const m = c.finalize(STUB_RESULT);
    expect(m.falseBargeInCount).toBe(1);
  });

  it("populates DFlash stats when the driver supplies them", () => {
    const c = new MetricsCollector({ fixtureId: "dflash" });
    c.record("speech-start");
    c.record("speech-end");
    c.record("audio-out-first-frame");
    const m = c.finalize({
      ...STUB_RESULT,
      dflashAccepted: 80,
      dflashDrafted: 100,
    });
    expect(m.dflashAccepted).toBe(80);
    expect(m.dflashDrafted).toBe(100);
  });

  it("populates rollbackCount + rollbackWasteTokens from rollback-drop events", () => {
    const c = new MetricsCollector({ fixtureId: "rollback" });
    c.record("speech-start");
    c.record("rollback-drop", { tokens: 4, reason: "false-eos" });
    c.record("rollback-drop", { tokens: 7, reason: "barge-in" });
    c.record("speech-end");
    c.record("audio-out-first-frame");
    const m = c.finalize(STUB_RESULT);
    expect(m.rollbackCount).toBe(2);
    expect(m.rollbackWasteTokens).toBe(11);
  });

  it("prefers driver-supplied rollbackWasteTokens over the event-derived sum", () => {
    const c = new MetricsCollector({ fixtureId: "rollback-override" });
    c.record("speech-start");
    c.record("rollback-drop", { tokens: 4 });
    c.record("rollback-drop"); // no payload
    c.record("speech-end");
    c.record("audio-out-first-frame");
    const m = c.finalize({ ...STUB_RESULT, rollbackWasteTokens: 99 });
    expect(m.rollbackCount).toBe(2);
    expect(m.rollbackWasteTokens).toBe(99);
  });

  it("defaults rollback metrics to zero when no rollback-drop events fire", () => {
    const c = new MetricsCollector({ fixtureId: "no-rollback" });
    c.record("speech-start");
    c.record("speech-end");
    c.record("audio-out-first-frame");
    const m = c.finalize(STUB_RESULT);
    expect(m.rollbackCount).toBe(0);
    expect(m.rollbackWasteTokens).toBe(0);
  });

  it("rejects out-of-order required events with a negative-latency error", () => {
    const c = new MetricsCollector({ fixtureId: "ooo" });
    // Record speech-end BEFORE speech-start to force a negative TTFA.
    c.record("speech-end");
    c.record("speech-start");
    c.record("audio-out-first-frame");
    expect(() => c.finalize(STUB_RESULT)).toThrow(/negative latency|out of order|speech-end/);
  });
});

describe("percentile", () => {
  it("returns the closest-rank percentile", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 95)).toBe(5);
    expect(percentile([10], 50)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });
});
