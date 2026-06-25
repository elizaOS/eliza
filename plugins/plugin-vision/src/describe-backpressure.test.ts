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

  it("pauses on RSS GROWTH over the cap and self-recovers when RSS drops back", () => {
    // Baseline 1500 MB (a local agent with multi-GB GGUF models resident),
    // cap = 500 MB of vision-attributable growth.
    let rss = 1500 * 1024 * 1024;
    const cap = 500 * 1024 * 1024;
    const ctrl = new DescribeBackpressureController({
      memoryCapBytes: cap,
      sampleRssBytes: () => rss,
    });

    // First call captures the baseline → growth 0 → describes.
    expect(ctrl.evaluate().describe).toBe(true);

    rss = 2100 * 1024 * 1024; // +600 MB growth, over the 500 MB cap
    const over = ctrl.evaluate();
    expect(over.describe).toBe(false);
    expect(over.reason).toBe("memory-cap");
    expect(over.transitionedTo).toBe("paused");

    rss = 1700 * 1024 * 1024; // +200 MB growth, back within cap
    const under = ctrl.evaluate();
    expect(under.describe).toBe(true);
    expect(under.transitionedTo).toBe("active");
  });

  it("does NOT pause on a high steady-state RSS (regression: absolute-RSS cap permanently blocked describing)", () => {
    // A real vision-enabled local agent mmaps multi-GB GGUF models; whole-process
    // RSS sits well above any MB cap. The growth-relative cap must NOT pause.
    const steadyRss = 4 * 1024 * 1024 * 1024; // 4 GB, constant
    const ctrl = new DescribeBackpressureController({
      memoryCapBytes: 2000 * 1024 * 1024, // documented MAX_MEMORY_USAGE_MB default
      sampleRssBytes: () => steadyRss,
    });
    for (let i = 0; i < 10; i++) {
      const d = ctrl.evaluate();
      expect(d.describe).toBe(true);
      expect(d.reason).toBeNull();
    }
    expect(ctrl.stats().describesSkipped).toBe(0);
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
    let rss = 100 * 1024 * 1024;
    const ctrl = new DescribeBackpressureController({
      memoryCapBytes: 1, // 1-byte growth cap
      sampleRssBytes: () => rss,
      now: () => now,
    });

    // First call captures baseline (100 MB) → no growth yet.
    expect(ctrl.evaluate().reason).toBeNull();
    // Grow RSS so the cap trips alone.
    rss = 200 * 1024 * 1024;
    expect(ctrl.evaluate().reason).toBe("memory-cap");

    // Arbiter pressure should now take precedence in the reported reason.
    ctrl.setPressure("critical");
    now += 1;
    expect(ctrl.evaluate().reason).toBe("arbiter-pressure");
  });
});
