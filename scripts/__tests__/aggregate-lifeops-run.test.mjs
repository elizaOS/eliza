#!/usr/bin/env bun
/**
 * Smoke test for `scripts/aggregate-lifeops-run.mjs` + `scripts/lifeops-bench-delta.mjs`.
 *
 * Builds a synthetic trajectory directory with 2 scenarios × 1 planner turn,
 * populates cache fields, runs the aggregator, validates the emitted
 * `report.json` against the canonical Zod schema, then runs the delta script
 * with baseline = candidate = same and asserts every delta is zero.
 *
 * Invocation: `bun scripts/__tests__/aggregate-lifeops-run.test.mjs`. The
 * script exits non-zero on the first failed assertion.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeltaSchema,
  REPORT_SCHEMA_VERSION,
  ReportSchema,
} from "@elizaos-benchmarks/lib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const failures = [];
function assert(cond, msg) {
  if (!cond) failures.push(msg);
}

// ---------------------------------------------------------------------------
// Build a synthetic run directory + 2 trajectory JSONs.
// ---------------------------------------------------------------------------

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "lifeops-aggregator-test-"),
);
const runDir = path.join(tmpRoot, "run");
const trajectoryDir = path.join(runDir, "trajectories");
fs.mkdirSync(trajectoryDir, { recursive: true });

const RUN_ID = "test-run-001";

function makeTrajectory({
  trajectoryId,
  scenarioId,
  finalDecision,
  cacheRead,
}) {
  return {
    trajectoryId,
    agentId: "agent-test",
    roomId: "room-test",
    runId: RUN_ID,
    scenarioId,
    rootMessage: { id: "msg-1", text: "test input", sender: "user" },
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_500,
    status: "finished",
    stages: [
      // messageHandler — intentionally excluded from the StageKind enum.
      {
        stageId: "stage-mh-1",
        kind: "messageHandler",
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_000_050,
        latencyMs: 50,
        model: {
          modelType: "RESPONSE_HANDLER",
          modelName: "gpt-oss-120b",
          provider: "cerebras",
          response: "{}",
          usage: {
            promptTokens: 100,
            completionTokens: 10,
            cacheReadInputTokens: cacheRead,
            cacheCreationInputTokens: 0,
            totalTokens: 110,
          },
          costUsd: 0.0001,
        },
      },
      // planner — becomes 1 TurnMetrics record.
      {
        stageId: "stage-planner-1",
        kind: "planner",
        iteration: 1,
        startedAt: 1_700_000_000_060,
        endedAt: 1_700_000_000_200,
        latencyMs: 140,
        model: {
          modelType: "ACTION_PLANNER",
          modelName: "gpt-oss-120b",
          provider: "cerebras",
          response: "",
          usage: {
            promptTokens: 800,
            completionTokens: 40,
            cacheReadInputTokens: cacheRead,
            cacheCreationInputTokens: 0,
            totalTokens: 840,
          },
          costUsd: 0.0008,
        },
      },
      // tool — folds into the active turn.
      {
        stageId: "stage-tool-1",
        kind: "tool",
        startedAt: 1_700_000_000_210,
        endedAt: 1_700_000_000_240,
        latencyMs: 30,
        tool: {
          name: "WEB_SEARCH",
          args: { q: "x" },
          result: { ok: true },
          success: true,
          durationMs: 30,
        },
      },
      // evaluation — extends turn.endedAt.
      {
        stageId: "stage-eval-1",
        kind: "evaluation",
        iteration: 1,
        startedAt: 1_700_000_000_250,
        endedAt: 1_700_000_000_400,
        latencyMs: 150,
        model: {
          modelType: "RESPONSE_HANDLER",
          modelName: "gpt-oss-120b",
          provider: "cerebras",
          response: '{"decision":"FINISH"}',
          usage: {
            promptTokens: 1000,
            completionTokens: 30,
            cacheReadInputTokens: cacheRead,
            cacheCreationInputTokens: 0,
            totalTokens: 1030,
          },
          costUsd: 0.0005,
        },
        evaluation: { success: true, decision: finalDecision },
      },
    ],
    metrics: {
      totalLatencyMs: 400,
      totalPromptTokens: 1900,
      totalCompletionTokens: 80,
      totalCacheReadTokens: cacheRead * 3,
      totalCacheCreationTokens: 0,
      totalCostUsd: 0.0014,
      plannerIterations: 1,
      toolCallsExecuted: 1,
      toolCallFailures: 0,
      toolSearchCount: 0,
      evaluatorFailures: 0,
      finalDecision,
    },
  };
}

fs.writeFileSync(
  path.join(trajectoryDir, "tj-1.json"),
  JSON.stringify(
    makeTrajectory({
      trajectoryId: "tj-1",
      scenarioId: "scenario.alpha",
      finalDecision: "FINISH",
      cacheRead: 200,
    }),
  ),
);
fs.writeFileSync(
  path.join(trajectoryDir, "tj-2.json"),
  JSON.stringify(
    makeTrajectory({
      trajectoryId: "tj-2",
      scenarioId: "scenario.beta",
      finalDecision: "error",
      cacheRead: 100,
    }),
  ),
);

// ---------------------------------------------------------------------------
// Run the aggregator under bun.
// ---------------------------------------------------------------------------

const aggregateResult = spawnSync(
  "bun",
  [
    path.join(REPO_ROOT, "scripts", "aggregate-lifeops-run.mjs"),
    "--run-dir",
    runDir,
    "--run-id",
    RUN_ID,
    "--harness",
    "eliza",
    "--model-tier",
    "large",
  ],
  { encoding: "utf8", cwd: REPO_ROOT },
);
if (aggregateResult.status !== 0) {
  console.error(`[test] aggregator stdout:\n${aggregateResult.stdout}`);
  console.error(`[test] aggregator stderr:\n${aggregateResult.stderr}`);
  failures.push(`aggregator exited with status ${aggregateResult.status}`);
}

const reportJsonPath = path.join(runDir, "report.json");
assert(fs.existsSync(reportJsonPath), "report.json should exist");

let report;
if (fs.existsSync(reportJsonPath)) {
  const reportRaw = JSON.parse(fs.readFileSync(reportJsonPath, "utf8"));
  const parsed = ReportSchema.safeParse(reportRaw);
  assert(
    parsed.success,
    `report.json must parse with ReportSchema: ${parsed.success ? "" : JSON.stringify(parsed.error?.issues)}`,
  );
  if (parsed.success) {
    report = parsed.data;
    assert(
      report.schemaVersion === REPORT_SCHEMA_VERSION,
      `schemaVersion expected ${REPORT_SCHEMA_VERSION} got ${report.schemaVersion}`,
    );
    assert(
      report.scenarios.length === 2,
      `expected 2 scenarios, got ${report.scenarios.length}`,
    );
    assert(
      report.harness === "eliza",
      `harness should be eliza, got ${report.harness}`,
    );
    assert(
      report.provider === "cerebras",
      `provider should be cerebras, got ${report.provider}`,
    );
    assert(
      report.rollup.scenarioCount === 2,
      `rollup.scenarioCount = ${report.rollup.scenarioCount}`,
    );
    assert(
      report.rollup.passCount === 1,
      `rollup.passCount should be 1, got ${report.rollup.passCount}`,
    );
    assert(
      report.rollup.passRate === 0.5,
      `rollup.passRate should be 0.5, got ${report.rollup.passRate}`,
    );
    assert(
      Array.isArray(report.notes) &&
        report.notes.some((n) => n.includes("cerebras")),
      "report.notes should mention cerebras",
    );
    for (const sc of report.scenarios) {
      assert(
        sc.turns.length === 1,
        `scenario ${sc.scenarioId} should have 1 turn`,
      );
      const turn = sc.turns[0];
      assert(
        turn.cacheSupported === true,
        `turn.cacheSupported should be true for cerebras`,
      );
      assert(turn.toolCalls.length === 1, `turn should have 1 tool call`);
      assert(turn.toolCalls[0].name === "WEB_SEARCH", "tool name mismatch");
      assert(
        sc.aggregateCacheHitPct !== null,
        "aggregateCacheHitPct should not be null when cache reported",
      );
    }
  }
}

// Check that report.md surfaced the cache-support line.
const reportMd = fs.readFileSync(path.join(runDir, "report.md"), "utf8");
assert(
  reportMd.includes("cache support") && reportMd.includes("Cerebras"),
  "report.md should mention cache support and Cerebras",
);

// ---------------------------------------------------------------------------
// Delta with baseline == candidate ⇒ all deltas zero.
// ---------------------------------------------------------------------------

const deltaOutDir = path.join(tmpRoot, "delta-out");
const deltaResult = spawnSync(
  "bun",
  [
    path.join(REPO_ROOT, "scripts", "lifeops-bench-delta.mjs"),
    "--baseline",
    reportJsonPath,
    "--candidate",
    reportJsonPath,
    "--out",
    deltaOutDir,
    "--baseline-label",
    "self",
    "--candidate-label",
    "self",
  ],
  { encoding: "utf8", cwd: REPO_ROOT },
);
if (deltaResult.status !== 0) {
  console.error(`[test] delta stdout:\n${deltaResult.stdout}`);
  console.error(`[test] delta stderr:\n${deltaResult.stderr}`);
  failures.push(`delta script exited with status ${deltaResult.status}`);
}

const deltaJsonPath = path.join(deltaOutDir, "delta.json");
assert(fs.existsSync(deltaJsonPath), "delta.json should exist");

if (fs.existsSync(deltaJsonPath)) {
  const deltaRaw = JSON.parse(fs.readFileSync(deltaJsonPath, "utf8"));
  const parsedDelta = DeltaSchema.safeParse(deltaRaw);
  assert(parsedDelta.success, `delta.json must parse with DeltaSchema`);
  if (parsedDelta.success) {
    const d = parsedDelta.data;
    assert(
      d.rollup.deltaPassRate === 0,
      `deltaPassRate should be 0, got ${d.rollup.deltaPassRate}`,
    );
    assert(
      d.rollup.deltaCostUsd === 0,
      `deltaCostUsd should be 0, got ${d.rollup.deltaCostUsd}`,
    );
    assert(
      d.rollup.deltaTotalTokens === 0,
      `deltaTotalTokens should be 0, got ${d.rollup.deltaTotalTokens}`,
    );
    assert(
      d.rollup.deltaCacheHitPct === 0,
      `deltaCacheHitPct should be 0, got ${d.rollup.deltaCacheHitPct}`,
    );
    assert(
      d.rollup.deltaTimeMs === 0,
      `deltaTimeMs should be 0, got ${d.rollup.deltaTimeMs}`,
    );
    for (const s of d.perScenario) {
      assert(
        s.deltaCostUsd === 0,
        `scenario ${s.scenarioId} deltaCostUsd should be 0`,
      );
      assert(
        s.deltaLatencyMs === 0,
        `scenario ${s.scenarioId} deltaLatencyMs should be 0`,
      );
      assert(
        s.deltaTotalTokens === 0,
        `scenario ${s.scenarioId} deltaTotalTokens should be 0`,
      );
      assert(
        s.deltaCacheHitPct === 0,
        `scenario ${s.scenarioId} deltaCacheHitPct should be 0`,
      );
      assert(
        s.passBaseline === s.passCandidate,
        "pass booleans should match for self-delta",
      );
    }
  }
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error("\n[test] FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\n[test] tmpRoot left for inspection: ${tmpRoot}`);
  process.exit(1);
}

// Clean up only on success.
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(
  "[test] aggregate-lifeops-run + lifeops-bench-delta smoke test PASSED",
);
