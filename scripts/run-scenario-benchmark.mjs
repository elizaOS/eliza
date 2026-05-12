#!/usr/bin/env node

/**
 * Weekly benchmark harness for the executive-assistant and connector
 * certification scenarios.
 *
 * Loads scenario ids from the filesystem (test/scenarios/executive-assistant/
 * and test/scenarios/connector-certification/), invokes the
 * `@elizaos/scenario-runner` CLI through scripts/run-live-scenarios.mjs (which
 * enforces SKIP_REASON + judge thresholds), and emits a markdown report to
 * artifacts/benchmark-report.md plus the raw JSON at
 * artifacts/lifeops-scenario-report.json.
 *
 * Required env: same LLM + connector credentials as live-scenarios.yml.
 * Optional:
 *   LIFEOPS_JUDGE_THRESHOLD (default 0.8)
 *   SCENARIO_FILTER         (comma-separated ids)
 *   BENCHMARK_ENFORCE_GATE  (default 1; set 0 for report-only runs)
 *   BENCHMARK_REPORT_PATH   (default: artifacts/benchmark-report.md)
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const EA_DIR = path.join(REPO_ROOT, "test", "scenarios", "executive-assistant");
const CONNECTOR_DIR = path.join(
  REPO_ROOT,
  "test",
  "scenarios",
  "connector-certification",
);
const SCENARIO_FILE_GLOBS = [
  "test/scenarios/executive-assistant/*.scenario.ts",
  "test/scenarios/connector-certification/*.scenario.ts",
];
const REPORT_JSON = path.join(
  REPO_ROOT,
  "artifacts",
  "lifeops-scenario-report.json",
);
const REPORT_MD =
  process.env.BENCHMARK_REPORT_PATH ??
  path.join(REPO_ROOT, "artifacts", "benchmark-report.md");

mkdirSync(path.dirname(REPORT_JSON), { recursive: true });
mkdirSync(path.dirname(REPORT_MD), { recursive: true });

/**
 * Extract the scenario id from a scenario source file. The scenario() call
 * always sets `id: "<kebab-id>"` on the top-level object.
 */
function extractScenarioId(filePath) {
  const src = readFileSync(filePath, "utf-8");
  const match = src.match(/id:\s*"([^"]+)"/);
  if (!match) {
    throw new Error(`[benchmark] could not extract id from ${filePath}`);
  }
  return match[1];
}

function collectScenarioIds(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".scenario.ts") && !file.startsWith("_"))
    .map((file) => ({
      file,
      id: extractScenarioId(path.join(dir, file)),
    }));
}

const eaScenarios = collectScenarioIds(EA_DIR);
const connectorScenarios = collectScenarioIds(CONNECTOR_DIR);
const allIds = [...eaScenarios, ...connectorScenarios].map((entry) => entry.id);

console.log(
  `[benchmark] discovered ${eaScenarios.length} EA scenarios + ${connectorScenarios.length} connector scenarios = ${allIds.length} total`,
);

const filter = (process.env.SCENARIO_FILTER ?? "").trim();
const scenariosToRun =
  filter.length > 0
    ? filter
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : allIds;

const runnerEnv = {
  ...process.env,
  ELIZA_LIVE_TEST: "1",
  LIFEOPS_JUDGE_THRESHOLD: process.env.LIFEOPS_JUDGE_THRESHOLD ?? "0.8",
  SCENARIO_ROOT: "test/scenarios",
  SCENARIO_FILTER: scenariosToRun.join(","),
  REPORT_PATH: REPORT_JSON,
};
const enforceGateValue = (process.env.BENCHMARK_ENFORCE_GATE ?? "1")
  .trim()
  .toLowerCase();
const enforceGate = !["0", "false", "no", "off"].includes(enforceGateValue);

console.log(
  `[benchmark] invoking scenario-runner for ${scenariosToRun.length} scenarios (threshold=${runnerEnv.LIFEOPS_JUDGE_THRESHOLD}, enforce=${enforceGate ? "yes" : "no"}, globs=${SCENARIO_FILE_GLOBS.join(",")})`,
);

const result = spawnSync(
  "node",
  ["scripts/run-live-scenarios.mjs", ...SCENARIO_FILE_GLOBS],
  {
    cwd: REPO_ROOT,
    env: runnerEnv,
    stdio: "inherit",
  },
);

// Runner exits non-zero on failure; we still want to emit a report.
const runnerExitCode = result.status ?? 1;

let report;
try {
  report = JSON.parse(readFileSync(REPORT_JSON, "utf-8"));
} catch (err) {
  console.error(`[benchmark] could not read report: ${err.message}`);
  report = { scenarios: [], totalCount: 0, failedCount: 0 };
}

function renderMarkdown() {
  const now = new Date().toISOString();
  const lines = [
    "# Executive-Assistant + Connector Benchmark",
    "",
    `- Run at: ${now}`,
    `- Commit: ${process.env.GITHUB_SHA ?? "local"}`,
    `- Judge threshold: ${runnerEnv.LIFEOPS_JUDGE_THRESHOLD}`,
    `- Total scenarios: ${scenariosToRun.length}`,
    `- Executed: ${report.totalCount ?? 0}`,
    `- Failed: ${report.failedCount ?? 0}`,
    `- Runner exit: ${runnerExitCode}`,
    `- Enforcement: ${enforceGate ? "blocking" : "report-only"}`,
    "",
    "## Results",
    "",
    "| Scenario | Domain | Status | Duration (ms) | Error |",
    "| --- | --- | --- | --- | --- |",
  ];
  const byId = new Map();
  for (const scenario of report.scenarios ?? []) {
    byId.set(scenario.id, scenario);
  }
  for (const entry of [...eaScenarios, ...connectorScenarios]) {
    if (!scenariosToRun.includes(entry.id)) continue;
    const result = byId.get(entry.id);
    const status = result?.status ?? "not-run";
    const duration = result?.durationMs ?? "-";
    const error = (result?.error ?? "")
      .replace(/\|/g, "\\|")
      .replace(/\n/g, " ");
    const domain = entry.file.startsWith("connector.")
      ? "connector"
      : "executive-assistant";
    lines.push(
      `| \`${entry.id}\` | ${domain} | ${status} | ${duration} | ${error} |`,
    );
  }
  lines.push("");
  lines.push(`## EA scenarios (${eaScenarios.length})`);
  lines.push("");
  for (const entry of eaScenarios) {
    lines.push(`- \`${entry.id}\``);
  }
  lines.push("");
  lines.push(`## Connector scenarios (${connectorScenarios.length})`);
  lines.push("");
  for (const entry of connectorScenarios) {
    lines.push(`- \`${entry.id}\``);
  }
  lines.push("");
  return lines.join("\n");
}

writeFileSync(REPORT_MD, renderMarkdown(), "utf-8");
console.log(`[benchmark] wrote markdown report to ${REPORT_MD}`);
console.log(`[benchmark] wrote JSON report to ${REPORT_JSON}`);

if (runnerExitCode !== 0 && !enforceGate) {
  console.warn(
    `[benchmark] scenario gate exited ${runnerExitCode}; BENCHMARK_ENFORCE_GATE=0 so the report is non-blocking.`,
  );
  process.exit(0);
}

process.exit(runnerExitCode);
