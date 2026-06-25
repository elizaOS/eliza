import { describe, expect, it } from "vitest";
import { DescribeBackpressureController } from "./describe-backpressure";

describe("DescribeBackpressureController", () => {
  it("describes every tick when there is no cap and no pressure", () => {
    const ctrl = new DescribeBackpressureController();
    for (let i = 0; i < 5; i++) {
      const d = ctrl.evaluate();
      expect(d.describe).toBe(true);
      expect(d.reason).toBeNull();
      expect(d.transitionedTo).toBeNull();
    }
    const stats = ctrl.stats();
    expect(stats.paused).toBe(false);
    expect(stats.describesSkipped).toBe(0);
    expect(stats.pauseTransitions).toBe(0);
  });

  it("pauses the describe step on arbiter pressure and reports the edge once", () => {
    let now = 1_000;
    const ctrl = new DescribeBackpressureController({
      arbiterPauseCooldownMs: 15_000,
      now: () => now,
    });

    // Healthy tick.
    expect(ctrl.evaluate().describe).toBe(true);

    // Pressure arrives.
    ctrl.setPressure("critical");
    const first = ctrl.evaluate();
    expect(first.describe).toBe(false);
    expect(first.reason).toBe("arbiter-pressure");
    expect(first.transitionedTo).toBe("paused");

    // Still within the cooldown window: paused, but no new transition edge.
    now += 5_000;
    const second = ctrl.evaluate();
    expect(second.describe).toBe(false);
    expect(second.transitionedTo).toBeNull();

    expect(ctrl.stats().describesSkipped).toBe(2);
    expect(ctrl.stats().pauseTransitions).toBe(1);
  });

  it("auto-resumes after the cooldown window of silence (WS1 bridge has no recovery edge)", () => {
    let now = 0;
    const ctrl = new DescribeBackpressureController({
      arbiterPauseCooldownMs: 15_000,
      now: () => now,
    });

    ctrl.setPressure("critical");
    expect(ctrl.evaluate().describe).toBe(false);

    // Past the cooldown with no further pressure → resume.
    now = 16_000;
    const resumed = ctrl.evaluate();
    expect(resumed.describe).toBe(true);
    expect(resumed.transitionedTo).toBe("active");
    expect(ctrl.stats().pauseTransitions).toBe(2);
  });

  it("clears immediately when a direct arbiter reports nominal", () => {
    let now = 0;
    const ctrl = new DescribeBackpressureController({ now: () => now });

    ctrl.setPressure("low");
    expect(ctrl.evaluate().describe).toBe(false);

    now += 100; // well inside the cooldown
    ctrl.setPressure("nominal");
    const d = ctrl.evaluate();
    expect(d.describe).toBe(true);
    expect(d.transitionedTo).toBe("active");
  });

  it("pauses on local RSS GROWTH past the cap and self-recovers when RSS drops", () => {
    let rss = 100 * 1024 * 1024; // 100 MB baseline (captured on the first tick)
    const cap = 500 * 1024 * 1024; // 500 MB of growth allowed
    const ctrl = new DescribeBackpressureController({
      memoryCapBytes: cap,
      sampleRssBytes: () => rss,
    });

    expect(ctrl.evaluate().describe).toBe(true); // baseline = 100 MB

    rss = 700 * 1024 * 1024; // growth 600 MB > 500 MB cap
    const over = ctrl.evaluate();
    expect(over.describe).toBe(false);
    expect(over.reason).toBe("memory-cap");
    expect(over.transitionedTo).toBe("paused");

    rss = 300 * 1024 * 1024; // growth 200 MB back under cap
    const under = ctrl.evaluate();
    expect(under.describe).toBe(true);
    expect(under.transitionedTo).toBe("active");
  });

  it("does NOT pause forever on a large-but-steady RSS (the #9693 regression)", () => {
    // A device that mmaps a multi-GB local model sits at ~3 GB RSS from tick 1.
    // With an absolute cap this paused describing on every tick forever; with
    // the growth-over-baseline cap a steady footprint never trips the guard.
    const steady = 3 * 1024 * 1024 * 1024; // 3 GB, constant
    const ctrl = new DescribeBackpressureController({
      memoryCapBytes: 2000 * 1024 * 1024, // the default 2000 MB cap
      sampleRssBytes: () => steady,
    });
    for (let i = 0; i < 100; i++) {
      expect(ctrl.evaluate().describe).toBe(true);
    }
    expect(ctrl.stats().describesSkipped).toBe(0);
  });

  it("escalates to an observable signal once a pause persists past warnAfterMs", () => {
    let now = 0;
    const ctrl = new DescribeBackpressureController({
      arbiterPauseCooldownMs: 10_000_000, // keep it paused for the whole test
      warnAfterMs: 60_000,
      warnRepeatMs: 60_000,
      now: () => now,
    });
    ctrl.setPressure("critical");
    // Just-paused: edge fires, but no escalation yet.
    expect(ctrl.evaluate().escalate).toBe(false);
    now = 30_000;
    expect(ctrl.evaluate().escalate).toBe(false); // 30s < 60s
    now = 61_000;
    const first = ctrl.evaluate();
    expect(first.escalate).toBe(true); // crossed 60s
    expect(first.continuousPauseMs).toBe(61_000);
    now = 90_000;
    expect(ctrl.evaluate().escalate).toBe(false); // within the repeat window
    now = 122_000;
    expect(ctrl.evaluate().escalate).toBe(true); // repeat after 60s
  });

  it("disables the local cap when memoryCapBytes is 0", () => {
    const ctrl = new DescribeBackpressureController({
      memoryCapBytes: 0,
      sampleRssBytes: () => 999 * 1024 * 1024 * 1024, // absurdly high
    });
    expect(ctrl.evaluate().describe).toBe(true);
  });

  it("reports arbiter pressure as the reason when both signals are active", () => {
    let now = 0;
    let rss = 0;
    const ctrl = new DescribeBackpressureController({
      memoryCapBytes: 1,
      sampleRssBytes: () => rss,
      now: () => now,
    });

    ctrl.evaluate(); // baseline tick (rss = 0)
    rss = 1024; // grow past the 1-byte cap
    // Cap alone first.
    expect(ctrl.evaluate().reason).toBe("memory-cap");

    // Arbiter pressure should now take precedence in the reported reason.
    ctrl.setPressure("critical");
    now += 1;
    expect(ctrl.evaluate().reason).toBe("arbiter-pressure");
  });
});
