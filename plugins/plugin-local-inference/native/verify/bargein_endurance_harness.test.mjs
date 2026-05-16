import assert from "node:assert/strict";
import test from "node:test";

import { buildBargeInReportFromE2e } from "./bargein_latency_harness.mjs";
import {
  buildThirtyTurnReportFromE2e,
  requiredOptimizationsOk,
} from "./thirty_turn_endurance_harness.mjs";

function args(overrides = {}) {
  return {
    tier: "0_8b",
    backend: "metal",
    bundle: "/tmp/eliza-1-0_8b.bundle",
    maxCancelMs: 80,
    turns: 30,
    rssGrowthMb: 64,
    rssCapMb: null,
    ...overrides,
  };
}

function kokoroRun(overrides = {}) {
  const requiredOptimizations = {
    dflashDraftingActive: null,
    dflashRequired: false,
    streamingTtsActive: true,
  };
  return {
    status: "ok",
    e2eLoopOk: true,
    thirtyTurnOk: true,
    request: {
      tier: "0_8b",
      backend: "metal",
      turns: 30,
    },
    bundle: {
      dir: "/tmp/eliza-1-0_8b.bundle",
      tier: "0_8b",
    },
    voiceLoop: {
      backend: "kokoro",
    },
    requiredOptimizations,
    summary: {
      turns: 30,
      thirtyTurnOk: true,
      bargeInCancelMs: 12.3,
      combinedPeakRssMb: 1600.5,
      ramBudgetRecommendedMb: 3700,
      ramWithinBudget: true,
      leakSuspected: false,
      requiredOptimizations,
      dflashPolicy: {
        status: "disabled",
        requiresDrafter: false,
        releaseMode: "fail-open-no-drafter",
      },
    },
    bargeIn: {
      kind: "kokoro-streaming-tts-cancel",
      bargeInCancelMs: 12.3,
      ttsCancelMs: 4.2,
      kokoroTtsCancelMs: 4.2,
      llmCancelMs: 12.3,
      ttsStreamSupported: true,
    },
    ...overrides,
  };
}

test("records Kokoro 0_8b barge-in latency when DFlash is disabled by policy", () => {
  const report = buildBargeInReportFromE2e({
    args: args(),
    e2eReport: kokoroRun(),
    e2eReportPath: "/tmp/e2e-kokoro.json",
  });

  assert.equal(report.status, "ok");
  assert.equal(report.available, true);
  assert.equal(report.summary.bargeInCancelMs, 12.3);
  assert.equal(report.summary.vadVoiceDetectedToTtsCancelledMs, 4.2);
  assert.equal(report.summary.vadVoiceDetectedToLlmCancelledMs, 12.3);
  assert.equal(report.evidence.source, "assembled-local-kokoro-voice-e2e-loop");
  assert.equal(report.evidence.dflashRequired, false);
  assert.deepEqual(report.evidence.blockers, []);
});

test("fails closed when a Kokoro barge-in run has no cancel metric", () => {
  const run = kokoroRun({
    summary: {
      ...kokoroRun().summary,
      bargeInCancelMs: null,
    },
    bargeIn: {
      ...kokoroRun().bargeIn,
      bargeInCancelMs: null,
    },
  });
  const report = buildBargeInReportFromE2e({
    args: args(),
    e2eReport: run,
    e2eReportPath: "/tmp/e2e-kokoro.json",
  });

  assert.equal(report.status, "failed");
  assert.equal(report.available, false);
  assert.equal(report.summary.bargeInCancelMs, null);
  assert.equal(
    report.evidence.blockers.some(
      (blocker) => blocker.key === "missing-barge-in-cancel-ms",
    ),
    true,
  );
});

test("records Kokoro 0_8b thirty-turn evidence without requiring a drafter", () => {
  const report = buildThirtyTurnReportFromE2e({
    args: args(),
    e2eReport: kokoroRun(),
    e2eReportPath: "/tmp/e2e-kokoro.json",
  });

  assert.equal(report.status, "ok");
  assert.equal(report.voiceLoopExercised, true);
  assert.equal(report.summary.thirtyTurnOk, true);
  assert.equal(report.summary.peakRssMb, 1600.5);
  assert.equal(report.evidence.source, "assembled-local-kokoro-voice-e2e-loop");
  assert.deepEqual(report.evidence.blockers, []);
});

test("required optimization checks only waive DFlash when the report marks it not required", () => {
  assert.equal(
    requiredOptimizationsOk({
      summary: {
        requiredOptimizations: {
          dflashDraftingActive: null,
          dflashRequired: false,
          streamingTtsActive: true,
        },
      },
    }),
    true,
  );
  assert.equal(
    requiredOptimizationsOk({
      summary: {
        requiredOptimizations: {
          dflashDraftingActive: null,
          dflashRequired: true,
          streamingTtsActive: true,
        },
      },
    }),
    false,
  );
});
