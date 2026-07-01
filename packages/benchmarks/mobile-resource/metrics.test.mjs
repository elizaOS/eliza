/**
 * Unit tests for the workbench aggregation + budget logic.
 * Run: node --test packages/benchmarks/mobile-resource/metrics.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkBudgets,
  computeThroughput,
  summarizeResourceRun,
} from "./metrics.mjs";

test("computeThroughput differences prefill/decode from a measured TTFT", () => {
  const t = computeThroughput({
    promptTokens: 64,
    outputTokens: 128,
    durationMs: 1000,
    ttftMs: 200,
  });
  assert.ok(Math.abs(t.prefillTokensPerSecond - 320) < 1e-6);
  assert.ok(Math.abs(t.decodeTokensPerSecond - 160) < 1e-6);
  assert.ok(Math.abs(t.combinedTokensPerSecond - 128) < 1e-6);
  assert.equal(t.ttftMs, 200);
});

test("computeThroughput keeps combined but nulls prefill/decode without TTFT", () => {
  const t = computeThroughput({
    promptTokens: 64,
    outputTokens: 128,
    durationMs: 1000,
  });
  assert.equal(t.prefillTokensPerSecond, null);
  assert.equal(t.decodeTokensPerSecond, null);
  assert.ok(Math.abs(t.combinedTokensPerSecond - 128) < 1e-6);
});

test("summarizeResourceRun aggregates generations + samples", () => {
  const summary = summarizeResourceRun(
    {
      generations: [
        { promptTokens: 64, outputTokens: 128, durationMs: 1000, ttftMs: 200 },
        { promptTokens: 64, outputTokens: 120, durationMs: 1000, ttftMs: 250 },
      ],
      samples: [
        {
          atMs: 0,
          residentMemoryMb: 900,
          batteryLevelPct: 80,
          thermalState: "nominal",
          lowPowerMode: false,
        },
        {
          atMs: 1000,
          residentMemoryMb: 1000,
          batteryLevelPct: 79,
          thermalState: "fair",
          lowPowerMode: false,
        },
        {
          atMs: 2000,
          residentMemoryMb: 1150,
          batteryLevelPct: 78,
          thermalState: "serious",
          lowPowerMode: true,
        },
        {
          atMs: 3000,
          residentMemoryMb: 1300,
          batteryLevelPct: 77,
          thermalState: "serious",
          lowPowerMode: true,
        },
      ],
    },
    { leakGrowthMbThreshold: 100 },
  );
  assert.equal(summary.generations, 2);
  assert.equal(summary.decodeTokensPerSecond.count, 2);
  assert.equal(summary.rss.peakMb, 1300);
  assert.equal(summary.rss.leakSuspected, true);
  assert.equal(summary.battery.drainPct, 3);
  assert.equal(summary.thermal.maxState, "serious");
  assert.equal(summary.thermal.samples, 4);
  assert.ok(Math.abs(summary.thermal.fractionThrottled - 0.5) < 1e-6);
  assert.equal(summary.lowPowerMode.everEnabled, true);
  assert.equal(summary.lowPowerMode.transitionCount, 1);
});

test("summarizeResourceRun reports nulls for unmeasured streams", () => {
  const summary = summarizeResourceRun({
    generations: [{}],
    samples: [{ atMs: 0 }],
  });
  assert.equal(summary.generations, 1);
  assert.equal(summary.prefillTokensPerSecond.count, 0);
  assert.equal(summary.prefillTokensPerSecond.p50, null);
  assert.equal(summary.rss.peakMb, null);
  assert.equal(summary.battery.drainPct, null);
  assert.equal(summary.thermal.fractionThrottled, null);
});

test("checkBudgets enforces min floors and max ceilings", () => {
  const summary = summarizeResourceRun({
    generations: [
      { promptTokens: 64, outputTokens: 128, durationMs: 1000, ttftMs: 200 },
    ],
    samples: [
      { atMs: 0, residentMemoryMb: 900 },
      { atMs: 1000, residentMemoryMb: 1000 },
    ],
  });
  const checks = checkBudgets(summary, {
    minDecodeTokensPerSecond: 100, // 160 measured → pass
    maxTtftMs: 100, // 200 measured → fail
    maxPeakRssMb: 2000, // 1000 measured → pass
  });
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  assert.equal(byName.decodeTokensPerSecondP50.pass, true);
  assert.equal(byName.ttftMsP90.pass, false);
  assert.equal(byName.peakRssMb.pass, true);
});

test("checkBudgets treats null budgets as no-baseline and missing values as pass by default", () => {
  const summary = summarizeResourceRun({ generations: [{}], samples: [] });
  const checks = checkBudgets(summary, {
    minDecodeTokensPerSecond: null, // no baseline
    maxPeakRssMb: 1500, // value not measured
  });
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  assert.equal(byName.decodeTokensPerSecondP50.note, "no-baseline");
  assert.equal(byName.decodeTokensPerSecondP50.pass, true);
  assert.equal(byName.peakRssMb.note, "not-measured");
  assert.equal(byName.peakRssMb.pass, true);
});

test("checkBudgets can fail closed on missing measurements", () => {
  const summary = summarizeResourceRun({ generations: [{}], samples: [] });
  const checks = checkBudgets(
    summary,
    { maxPeakRssMb: 1500 },
    { failOnMissing: true },
  );
  const peak = checks.find((c) => c.name === "peakRssMb");
  assert.equal(peak.pass, false);
});
