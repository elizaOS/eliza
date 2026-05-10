#!/usr/bin/env node
/**
 * Run the full lifeops verification pipeline end-to-end.
 *
 * Steps (each gates the next):
 *   1. Verify Cerebras eval helper reachable.
 *   2. Run lifeops-prompt-benchmark (self-care suite) with --run-dir.
 *   3. Run scenario-runner over each lifeops scenario directory.
 *   4. Run vitest integration tests under app-lifeops (deterministic only).
 *   5. Aggregate via aggregate-lifeops-run.mjs.
 *
 * Usage:
 *   node scripts/lifeops-full-run.mjs [--variants 'direct,distracted-rambling'] [--scenario-dirs 'plugins/app-lifeops/test/scenarios,test/scenarios/lifeops.habits'] [--skip-integration]
 *
 * Required env (sourced from eliza/.env automatically):
 *   - CEREBRAS_API_KEY (for evaluation/judge)
 *   - ANTHROPIC_API_KEY (for the agent under test)
 *
 * Output:
 *   ~/.milady/runs/lifeops/lifeops-full-<timestamp>/
 *     trajectories/             # raw JSON per turn
 *     scenarios/<idx>-<id>/     # per-scenario JSONL
 *     report.md                 # aggregated report
 *     steps.csv                 # flat per-step metrics
 *     benchmark-report.json     # benchmark suite output
 *     benchmark-report.md       # benchmark suite markdown
 *     scenario-runner-report.json  # scenario-runner aggregate
 *     vitest-output.log         # integration-test stdout
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length
    ? process.argv[idx + 1]
    : fallback;
}
const flag = (name) => process.argv.includes(name);

const variants = arg("--variants", "direct").split(",").map((s) => s.trim()).filter(Boolean);
const scenarioDirs = arg(
  "--scenario-dirs",
  [
    "plugins/app-lifeops/test/scenarios",
    "test/scenarios/lifeops.habits",
    "test/scenarios/lifeops.workflow-events",
  ].join(","),
).split(",").map((s) => s.trim()).filter(Boolean);
const skipIntegration = flag("--skip-integration");
const skipBenchmark = flag("--skip-benchmark");
const skipScenarios = flag("--skip-scenarios");

const RUN_ID = `lifeops-full-${Date.now()}`;
const RUN_DIR = join(homedir(), ".milady", "runs", "lifeops", RUN_ID);
mkdirSync(join(RUN_DIR, "trajectories"), { recursive: true });

const env = {
  ...process.env,
  ELIZA_LIVE_TEST: "1",
  MILADY_TRAJECTORY_DIR: join(RUN_DIR, "trajectories"),
  MILADY_LIFEOPS_RUN_ID: RUN_ID,
  MILADY_LIFEOPS_RUN_DIR: RUN_DIR,
};
// Don't auto-pick Cerebras for the agent unless the operator explicitly
// asked for it via MILADY_PROVIDER or OPENAI_BASE_URL. The agent stays on
// Anthropic Opus 4.7; Cerebras gpt-oss-120b grades it.
delete env.OPENAI_BASE_URL;
delete env.MILADY_PROVIDER;

console.log(`[lifeops-full-run] RUN_ID=${RUN_ID}`);
console.log(`[lifeops-full-run] RUN_DIR=${RUN_DIR}`);

function run(label, cmd, cmdArgs, opts = {}) {
  console.log(`\n[lifeops-full-run] ▶ ${label}`);
  console.log(`[lifeops-full-run]   ${cmd} ${cmdArgs.join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: opts.env ?? env,
    stdio: opts.stdio ?? "inherit",
    encoding: "utf8",
  });
  if (r.status !== 0 && !opts.allowFail) {
    console.error(
      `[lifeops-full-run] ✗ ${label} exited with status ${r.status}`,
    );
  } else {
    console.log(
      `[lifeops-full-run] ${r.status === 0 ? "✓" : "·"} ${label} (status=${r.status})`,
    );
  }
  return r;
}

// 1. Verify Cerebras reachable.
const verify = run(
  "verify-cerebras-wiring",
  "bun",
  ["--bun", "plugins/app-lifeops/scripts/verify-cerebras-wiring.ts"],
  { allowFail: false },
);
if (verify.status !== 0) {
  console.error("[lifeops-full-run] aborting: Cerebras unreachable");
  process.exit(2);
}

// 2. Benchmark per variant.
if (!skipBenchmark) {
  for (const variant of variants) {
    const benchmarkArgs = [
      "--bun",
      "packages/app-core/scripts/lifeops-prompt-benchmark.ts",
      "--suite",
      "self-care",
      "--variant",
      variant,
      "--report",
      join(RUN_DIR, `benchmark-report-${variant}.json`),
      "--markdown",
      join(RUN_DIR, `benchmark-report-${variant}.md`),
      "--ax",
      join(RUN_DIR, `benchmark-ax-${variant}.jsonl`),
    ];
    run(`benchmark variant=${variant}`, "bun", benchmarkArgs, { allowFail: true });
  }
}

// 3. Scenario-runner per directory.
if (!skipScenarios) {
  for (const dir of scenarioDirs) {
    const fullDir = join(REPO_ROOT, dir);
    if (!existsSync(fullDir)) {
      console.warn(`[lifeops-full-run] skip ${dir} — not found`);
      continue;
    }
    const reportPath = join(
      RUN_DIR,
      `scenario-runner-report-${dir.replaceAll("/", "_")}.json`,
    );
    run(
      `scenario-runner ${dir}`,
      "bun",
      [
        "--bun",
        "packages/scenario-runner/src/cli.ts",
        "run",
        fullDir,
        "--run-dir",
        RUN_DIR,
        "--runId",
        RUN_ID,
        "--report",
        reportPath,
      ],
      { allowFail: true },
    );
  }
}

// 4. Vitest integration tests (deterministic only; no .live./.real. files).
if (!skipIntegration) {
  run(
    "vitest integration",
    "bun",
    [
      "x",
      "vitest",
      "run",
      "--reporter=verbose",
      "plugins/app-lifeops/test",
      "--testNamePattern",
      "integration",
    ],
    { allowFail: true },
  );
}

// 5. Aggregate.
run(
  "aggregate-lifeops-run",
  "node",
  [
    "scripts/aggregate-lifeops-run.mjs",
    "--run-dir",
    RUN_DIR,
    "--run-id",
    RUN_ID,
  ],
  { allowFail: false },
);

// Summary.
const reportMd = join(RUN_DIR, "report.md");
if (existsSync(reportMd)) {
  console.log("\n[lifeops-full-run] ===== aggregated report (head) =====");
  console.log(readFileSync(reportMd, "utf8").split("\n").slice(0, 40).join("\n"));
}

console.log(`\n[lifeops-full-run] DONE`);
console.log(`[lifeops-full-run] artifacts: ${RUN_DIR}`);
