import { describe, it, expect } from "bun:test";
import { buildScenarios, SCENARIO_IDS } from "../scenarios.ts";
import { MockPipelineDriver } from "../mock-driver.ts";
import { MetricsCollector } from "../metrics.ts";
import { runBench } from "../runner.ts";
import { evaluateGates, aggregate, DEFAULT_GATES } from "../gates.ts";
import type { BenchMetrics, BenchRun, PipelineDriver } from "../types.ts";

async function collectUnitRun(args: {
  driver: PipelineDriver;
  bundleId: string;
  scenarios?: string[];
}): Promise<BenchRun> {
  const selected = buildScenarios().filter((s) =>
    args.scenarios ? args.scenarios.includes(s.scenario.id) : true,
  );
  const fixtures: BenchMetrics[] = [];
  for (const build of selected) {
    const collector = new MetricsCollector({ fixtureId: build.scenario.id });
    const result = await args.driver.run({
      audio: build.audio,
      injection: build.scenario.injection,
      probe: collector.record,
    });
    fixtures.push(collector.finalize(result));
  }
  return {
    runId: `unit-${args.bundleId}`,
    timestamp: new Date(0).toISOString(),
    gitSha: "unit",
    bundleId: args.bundleId,
    backend: args.driver.backend,
    deviceLabel: "unit",
    fixtures,
    aggregates: aggregate(fixtures),
  };
}

describe("scenarios", () => {
  it("emits the canonical scenario set", () => {
    const built = buildScenarios();
    expect(built.map((b) => b.scenario.id)).toEqual([...SCENARIO_IDS]);
  });

  it("includes the false-end-of-speech and barge-in-mid-response rollback scenarios", () => {
    const ids = buildScenarios().map((b) => b.scenario.id);
    expect(ids).toContain("false-end-of-speech");
    expect(ids).toContain("barge-in-mid-response");
  });

  for (const id of SCENARIO_IDS) {
    it(`smoke-tests scenario "${id}" end-to-end against the mock driver`, async () => {
      const built = buildScenarios().find((b) => b.scenario.id === id)!;
      const driver = new MockPipelineDriver();
      const collector = new MetricsCollector({ fixtureId: id });
      const result = await driver.run({
        audio: built.audio,
        injection: built.scenario.injection,
        probe: collector.record,
      });
      expect(result.exitReason).toBe("done");
      const m = collector.finalize(result);
      expect(m.ttfaMs).toBeGreaterThan(0);
      expect(m.speechEndToFirstAudioMs).toBeGreaterThan(0);
      if (id === "barge-in" || id === "barge-in-mid-response") {
        expect(m.bargeInResponseMs).toBeDefined();
        expect(m.bargeInResponseMs!).toBeGreaterThan(0);
        expect(m.bargeInResponseMs!).toBeLessThan(250);
        // Rollback-drop event fired by the mock driver on barge-in.
        expect(m.rollbackCount).toBeGreaterThanOrEqual(1);
        expect(m.rollbackWasteTokens).toBeGreaterThan(0);
      }
      if (id === "false-end-of-speech") {
        // Mock driver emits a rollback-drop for the mid-clause pause.
        expect(m.rollbackCount).toBeGreaterThanOrEqual(1);
        expect(m.rollbackWasteTokens).toBeGreaterThan(0);
      }
    });
  }
});

describe("runBench real-driver guard", () => {
  it("rejects mock drivers before writing benchmark output", async () => {
    await expect(
      runBench({
        driver: new MockPipelineDriver(),
        bundleId: "test-bundle",
      }),
    ).rejects.toThrow(/mock\/fake\/stub drivers are not permitted/);
  });

  it("unit helper still exercises aggregation without benchmark output", async () => {
    const run = await collectUnitRun({
      driver: new MockPipelineDriver(),
      bundleId: "test-bundle",
    });
    expect(run.fixtures.length).toBe(SCENARIO_IDS.length);
    expect(run.aggregates.ttfaP50).toBeGreaterThan(0);
    expect(run.aggregates.ttfaP95).toBeGreaterThanOrEqual(run.aggregates.ttfaP50);
    expect(run.aggregates.rollbackWastePct).toBeGreaterThan(0);
    expect(run.aggregates.rollbackWastePct).toBeLessThan(1);
    expect(run.bundleId).toBe("test-bundle");
    expect(run.backend).toBe("mock");
  });

  it("unit helper accepts a scenario filter", async () => {
    const run = await collectUnitRun({
      driver: new MockPipelineDriver(),
      bundleId: "test-bundle",
      scenarios: ["short-turn", "barge-in"],
    });
    expect(run.fixtures.map((f) => f.fixtureId).sort()).toEqual(
      ["barge-in", "short-turn"],
    );
  });

  it("rejects unknown scenario ids", async () => {
    await expect(
      runBench({
        driver: new MockPipelineDriver(),
        bundleId: "test-bundle",
        scenarios: ["does-not-exist"],
      }),
    ).rejects.toThrow(/unknown scenario id/);
  });
});

describe("gates", () => {
  it("aggregates p50/p95 across fixtures", () => {
    const agg = aggregate([
      {
        fixtureId: "a",
        ttfaMs: 100,
        e2eLatencyMs: 1000,
        speechEndToFirstAudioMs: 50,
        falseBargeInCount: 0,
        draftTokensTotal: 10,
        draftTokensWasted: 1,
        rollbackCount: 0,
        rollbackWasteTokens: 0,
        peakRssMb: 100,
        peakCpuPct: 50,
      },
      {
        fixtureId: "b",
        ttfaMs: 200,
        e2eLatencyMs: 1500,
        speechEndToFirstAudioMs: 60,
        falseBargeInCount: 0,
        draftTokensTotal: 10,
        draftTokensWasted: 2,
        rollbackCount: 0,
        rollbackWasteTokens: 0,
        peakRssMb: 100,
        peakCpuPct: 50,
      },
    ]);
    expect(agg.ttfaP50).toBe(100);
    expect(agg.ttfaP95).toBe(200);
    expect(agg.rollbackWastePct).toBeCloseTo(0.15, 5);
  });

  it("passes against a permissive baseline", async () => {
    const run = await collectUnitRun({
      driver: new MockPipelineDriver(),
      bundleId: "current",
    });
    const baseline = await collectUnitRun({
      driver: new MockPipelineDriver(),
      bundleId: "baseline",
    });
    const report = evaluateGates({ current: run, baseline });
    expect(report.passed).toBe(true);
    expect(report.markdown).toContain("Voice-bench gate report");
    expect(report.rows.some((r) => r.metric.startsWith("TTFA"))).toBe(true);
  });

  it("fails when current TTFA exceeds the fail threshold", async () => {
    const baseline = await collectUnitRun({
      driver: new MockPipelineDriver(),
      bundleId: "baseline",
    });
    // Simulate a 100%+ regression — ttfa doubled vs the default mock.
    // Mock driver defaults to firstAcceptMs=35, ttsFirstPcmMs=12, so doubling
    // pushes the slow run well over the +50% fail threshold while keeping
    // the test fast.
    const slow = await collectUnitRun({
      driver: new MockPipelineDriver({ firstAcceptMs: 150, ttsFirstPcmMs: 80 }),
      bundleId: "slow",
    });
    const report = evaluateGates({
      current: slow,
      baseline,
      gates: DEFAULT_GATES,
    });
    expect(report.passed).toBe(false);
    expect(report.rows.some((r) => r.severity === "fail")).toBe(true);
  });

  it("flags rollback waste above the absolute ceiling", async () => {
    const run = await collectUnitRun({
      driver: new MockPipelineDriver({
        draftTokensTotal: 100,
        draftTokensWasted: 50,
      }),
      bundleId: "wasteful",
    });
    const report = evaluateGates({ current: run });
    const waste = report.rows.find((r) => r.metric.startsWith("Rollback waste"));
    expect(waste).toBeDefined();
    expect(waste!.severity).toBe("fail");
  });
});
