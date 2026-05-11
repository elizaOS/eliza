#!/usr/bin/env bun
/**
 * Round-trip test for `preRelease` propagation through the aggregator.
 * Builds a synthetic trajectory, runs the aggregator with `--pre-release`,
 * and asserts:
 *
 *   1. `report.json` has `preRelease: true` at the top level AND on every
 *      `scenarios[].preRelease` field.
 *   2. `report.md` opens with the pre-release banner block.
 *   3. Running again without `--pre-release` flips both flags to `false` and
 *      omits the banner.
 *
 * pre-release must not be silently coerced. This test guards against any
 * future regression that defaults the flag to `false` after a malformed-bundle
 * code path.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReportSchema } from "@elizaos-benchmarks/lib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const failures = [];
function assert(cond, msg) {
  if (!cond) failures.push(msg);
}

function buildSyntheticRun(rootDir) {
  const runDir = path.join(rootDir, "run");
  const trajectoryDir = path.join(runDir, "trajectories");
  fs.mkdirSync(trajectoryDir, { recursive: true });
  const trajectory = {
    trajectoryId: "tj-pre-release-1",
    agentId: "agent-test",
    roomId: "room-test",
    runId: "pre-release-run-001",
    scenarioId: "scenario.alpha",
    rootMessage: { id: "msg-1", text: "test", sender: "user" },
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_400,
    status: "finished",
    stages: [
      {
        stageId: "stage-planner-1",
        kind: "planner",
        iteration: 1,
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_000_200,
        latencyMs: 200,
        model: {
          modelType: "ACTION_PLANNER",
          modelName: "eliza-1-0.6b",
          provider: "local-llama-cpp",
          response: "",
          usage: {
            promptTokens: 800,
            completionTokens: 40,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            totalTokens: 840,
          },
          costUsd: 0,
        },
      },
      {
        stageId: "stage-eval-1",
        kind: "evaluation",
        iteration: 1,
        startedAt: 1_700_000_000_210,
        endedAt: 1_700_000_000_400,
        latencyMs: 190,
        model: {
          modelType: "RESPONSE_HANDLER",
          modelName: "eliza-1-0.6b",
          provider: "local-llama-cpp",
          response: '{"decision":"FINISH"}',
          usage: {
            promptTokens: 200,
            completionTokens: 20,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            totalTokens: 220,
          },
          costUsd: 0,
        },
        evaluation: { success: true, decision: "FINISH" },
      },
    ],
    metrics: {
      totalLatencyMs: 400,
      totalPromptTokens: 1000,
      totalCompletionTokens: 60,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalCostUsd: 0,
      plannerIterations: 1,
      toolCallsExecuted: 0,
      toolCallFailures: 0,
      toolSearchCount: 0,
      evaluatorFailures: 0,
      finalDecision: "FINISH",
    },
  };
  fs.writeFileSync(
    path.join(trajectoryDir, "tj-1.json"),
    JSON.stringify(trajectory),
  );
  return runDir;
}

function runAggregator(runDir, extraArgs = []) {
  return spawnSync(
    "bun",
    [
      path.join(REPO_ROOT, "scripts", "aggregate-lifeops-run.mjs"),
      "--run-dir",
      runDir,
      "--run-id",
      "pre-release-run-001",
      "--harness",
      "eliza",
      "--model-tier",
      "small",
      ...extraArgs,
    ],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
}

// ----- Run 1: --pre-release flag set -----
{
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "lifeops-aggregator-pre-release-on-"),
  );
  const runDir = buildSyntheticRun(tmpRoot);
  const res = runAggregator(runDir, ["--pre-release"]);
  if (res.status !== 0) {
    console.error("[test] aggregator stdout:\n" + res.stdout);
    console.error("[test] aggregator stderr:\n" + res.stderr);
    failures.push(`aggregator (pre-release) exited with status ${res.status}`);
  }
  const reportJsonPath = path.join(runDir, "report.json");
  assert(fs.existsSync(reportJsonPath), "report.json should exist");
  if (fs.existsSync(reportJsonPath)) {
    const parsed = ReportSchema.safeParse(
      JSON.parse(fs.readFileSync(reportJsonPath, "utf8")),
    );
    assert(parsed.success, "report.json should parse with ReportSchema");
    if (parsed.success) {
      const r = parsed.data;
      assert(r.preRelease === true, "report.preRelease should be true");
      for (const sc of r.scenarios) {
        assert(
          sc.preRelease === true,
          `scenario ${sc.scenarioId} preRelease should be true`,
        );
      }
    }
  }
  const reportMd = fs.readFileSync(path.join(runDir, "report.md"), "utf8");
  assert(
    reportMd.includes("PRE-RELEASE"),
    "report.md should contain the PRE-RELEASE banner",
  );
  assert(
    reportMd.includes("local-standin"),
    "report.md banner should call out the local-standin releaseState",
  );
  assert(
    reportMd.includes("publishEligible: false"),
    "report.md banner should call out publishEligible: false",
  );
}

// ----- Run 2: flag absent -----
{
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "lifeops-aggregator-pre-release-off-"),
  );
  const runDir = buildSyntheticRun(tmpRoot);
  const res = runAggregator(runDir);
  if (res.status !== 0) {
    console.error("[test] aggregator stdout:\n" + res.stdout);
    console.error("[test] aggregator stderr:\n" + res.stderr);
    failures.push(`aggregator (no pre-release) exited with status ${res.status}`);
  }
  const reportJsonPath = path.join(runDir, "report.json");
  if (fs.existsSync(reportJsonPath)) {
    const parsed = ReportSchema.safeParse(
      JSON.parse(fs.readFileSync(reportJsonPath, "utf8")),
    );
    if (parsed.success) {
      const r = parsed.data;
      assert(r.preRelease === false, "report.preRelease should be false");
      for (const sc of r.scenarios) {
        assert(
          sc.preRelease === false,
          `scenario ${sc.scenarioId} preRelease should be false`,
        );
      }
    }
  }
  const reportMd = fs.readFileSync(path.join(runDir, "report.md"), "utf8");
  assert(
    !reportMd.includes("PRE-RELEASE"),
    "report.md without --pre-release must not include the banner",
  );
}

if (failures.length > 0) {
  console.error("\n[test] FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[test] OK — preRelease propagates through aggregator");
