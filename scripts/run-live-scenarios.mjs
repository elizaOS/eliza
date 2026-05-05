#!/usr/bin/env node
/**
 * Wrapper around the `/scenario-runner` CLI.
 *
 * Responsibilities:
 *   1. Ensure SKIP_REASON gating: when scenarios are filtered/skipped via
 *      SCENARIO_SKIP, an explicit SKIP_REASON env var must be set or this
 *      wrapper exits non-zero.
 *   2. Forward to the scenario CLI at
 *      `packages/scenario-runner/src/cli.ts`.
 *   3. Fail loudly if the CLI reports failure.
 *
 * Required env:
 *   - ELIZA_LIVE_TEST=1 (asserted)
 *   - At least one LLM provider key (OPENAI_API_KEY, OPENROUTER_API_KEY, etc.)
 *
 * Optional env:
 *   - LIFEOPS_JUDGE_THRESHOLD: minimum LLM judge score (default 0.8). Forwarded
 *     to the CLI via LIFEOPS_LIVE_JUDGE_MIN_SCORE.
 *   - SCENARIO_FILTER: comma-separated scenario IDs (forwards as --scenario).
 *   - SCENARIO_ROOT: scenario directory, relative to repo root or absolute
 *     (default: plugins/app-lifeops/test/scenarios).
 *   - SCENARIO_INCLUDE_PENDING=1: include scenarios marked status="pending".
 *   - SCENARIO_ENFORCE_GATE=0: keep the workflow green while still writing
 *     the report when scenario assertions fail.
 *   - SKIP_REASON: required when any scenario is intentionally skipped.
 *   - REPORT_PATH: where to write the JSON report (default: artifacts/lifeops-scenario-report.json).
 *
 * Usage:
 *   node scripts/run-live-scenarios.mjs [--list] [--scenario id1,id2] [--report path]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SCENARIO_CLI = path.join(
  REPO_ROOT,
  "packages",
  "scenario-runner",
  "src",
  "cli.ts",
);
const LIFEOPS_SCENARIO_ROOT = path.join(
  REPO_ROOT,
  "plugins",
  "app-lifeops",
  "test",
  "scenarios",
);
const scenarioRootInput = (process.env.SCENARIO_ROOT ?? "").trim();
const scenarioRoot =
  scenarioRootInput.length > 0
    ? path.resolve(REPO_ROOT, scenarioRootInput)
    : LIFEOPS_SCENARIO_ROOT;

if (!existsSync(SCENARIO_CLI)) {
  console.error(
    `[run-live-scenarios] scenario-runner CLI missing at ${SCENARIO_CLI}.`,
  );
  process.exit(2);
}

if (process.env.ELIZA_LIVE_TEST !== "1") {
  console.error(
    "[run-live-scenarios] refusing to run: ELIZA_LIVE_TEST=1 is required.",
  );
  process.exit(2);
}

const skipFilter = (process.env.SCENARIO_SKIP ?? "").trim();
const skipReason = (process.env.SKIP_REASON ?? "").trim();
if (skipFilter.length > 0 && skipReason.length === 0) {
  console.error(
    `[run-live-scenarios] SCENARIO_SKIP="${skipFilter}" requires SKIP_REASON to document why. ` +
      `Set SKIP_REASON="<concrete reason>" to acknowledge.`,
  );
  process.exit(2);
}
if (skipReason.length > 0) {
  console.warn(
    `[run-live-scenarios] SKIP_REASON acknowledged: "${skipReason}" (filter="${skipFilter}")`,
  );
}

const reportPath =
  process.env.REPORT_PATH ??
  path.join(REPO_ROOT, "artifacts", "lifeops-scenario-report.json");
mkdirSync(path.dirname(reportPath), { recursive: true });

const args = [
  "--import",
  "tsx",
  SCENARIO_CLI,
  "run",
  scenarioRoot,
  "--report",
  reportPath,
  ...process.argv.slice(2),
];
const filter = (process.env.SCENARIO_FILTER ?? "").trim();
if (filter.length > 0) {
  args.push("--scenario", filter);
}

const judgeThreshold = process.env.LIFEOPS_JUDGE_THRESHOLD ?? "0.8";
const enforceGateValue = (process.env.SCENARIO_ENFORCE_GATE ?? "1")
  .trim()
  .toLowerCase();
const enforceGate = !["0", "false", "no", "off"].includes(enforceGateValue);
const env = {
  ...process.env,
  ELIZA_LIVE_TEST: "1",
  LIFEOPS_LIVE_JUDGE_MIN_SCORE: judgeThreshold,
};

console.log(
  `[run-live-scenarios] threshold=${judgeThreshold} enforce=${enforceGate ? "yes" : "no"} pending=${env.SCENARIO_INCLUDE_PENDING === "1" ? "included" : "excluded"} report=${reportPath} args=${args.slice(2).join(" ")}`,
);

const child = spawn(process.execPath, args, {
  cwd: REPO_ROOT,
  env,
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[run-live-scenarios] killed by signal ${signal}`);
    process.exit(1);
  }
  const exitCode = code ?? 1;
  if (exitCode !== 0 && !enforceGate) {
    console.warn(
      `[run-live-scenarios] scenario gate exited ${exitCode}; SCENARIO_ENFORCE_GATE=0 so the report is non-blocking.`,
    );
    process.exit(0);
  }
  process.exit(exitCode);
});
