#!/usr/bin/env node
/**
 * Per-scenario-isolation wrapper around the scenario-runner CLI.
 *
 * Why this exists:
 *   The in-process CLI runs all scenarios against a single shared runtime
 *   because PGLite cannot be torn down and restarted inside one bun process
 *   (the native binding segfaults on reinit). For true state isolation
 *   between scenarios — required when cross-scenario memory, classifier
 *   context, or embedding state can leak — we spawn a fresh CLI invocation
 *   per scenario, each in its own process.
 *
 * Trade-offs:
 *   - Slower (one runtime boot per scenario, ~3-8s overhead each).
 *   - Reliable: zero cross-scenario state leakage, zero PGLite restart
 *     crashes, zero rate-limit accumulation inside a single runtime.
 *
 * Usage:
 *   bun scripts/run-scenarios-isolated.mjs <scenarios-dir> [--report <path>]
 *
 * Env:
 *   Same as the underlying CLI (GROQ_API_KEY / OPENAI_API_KEY / etc.).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CLI = path.join(
  REPO_ROOT,
  "eliza",
  "packages",
  "scenario-runner",
  "src",
  "cli.ts",
);

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: run-scenarios-isolated.mjs <dir> [--report <path>]");
  process.exit(2);
}

const dir = path.resolve(args[0]);
let reportPath = null;
for (let i = 1; i < args.length; i += 1) {
  if (args[i] === "--report" && args[i + 1]) {
    reportPath = path.resolve(args[i + 1]);
    i += 1;
  }
}

if (!fs.existsSync(dir)) {
  console.error(`[isolated] scenarios dir not found: ${dir}`);
  process.exit(2);
}

// 1. List scenario IDs from the target dir.
const listed = spawnSync("bun", [CLI, "list", dir], {
  cwd: REPO_ROOT,
  encoding: "utf8",
  stdio: ["inherit", "pipe", "inherit"],
});
if (listed.status !== 0) {
  console.error(`[isolated] scenario listing failed (exit ${listed.status})`);
  process.exit(listed.status ?? 1);
}
const ids = listed.stdout
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

console.error(
  `[isolated] running ${ids.length} scenario(s) in isolated processes`,
);

// 2. Run each scenario in its own child process, collect per-run reports.
const perRunReports = [];
const startedAtIso = new Date().toISOString();
let passed = 0;
let failed = 0;
let skipped = 0;

for (const id of ids) {
  const tmpReport = path.join(
    "/tmp",
    `scenario-isolated-${id.replace(/[^a-z0-9._-]/gi, "_")}.json`,
  );
  const child = spawnSync(
    "bun",
    [CLI, "run", dir, "--scenario", id, "--report", tmpReport],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["inherit", "inherit", "inherit"],
      env: process.env,
    },
  );
  if (!fs.existsSync(tmpReport)) {
    console.error(`[isolated] ${id} produced no report (exit ${child.status})`);
    failed += 1;
    continue;
  }
  try {
    const r = JSON.parse(fs.readFileSync(tmpReport, "utf8"));
    perRunReports.push(r);
    const s = (r.scenarios ?? [])[0];
    if (!s) {
      failed += 1;
    } else if (s.status === "passed") {
      passed += 1;
    } else if (s.status === "skipped") {
      skipped += 1;
    } else {
      failed += 1;
    }
  } catch (err) {
    console.error(`[isolated] ${id} report parse failed: ${err.message}`);
    failed += 1;
  }
}

const completedAtIso = new Date().toISOString();

// 3. Aggregate into a single report.
const aggregate = {
  runId: `isolated-${Date.now()}`,
  providerName: perRunReports[0]?.providerName ?? "unknown",
  startedAtIso,
  completedAtIso,
  totals: { passed, failed, skipped, total: ids.length },
  scenarios: perRunReports.flatMap((r) => r.scenarios ?? []),
};

if (reportPath) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(aggregate, null, 2));
  console.error(`[isolated] wrote report to ${reportPath}`);
}

console.error("");
console.error(
  `[isolated] Totals: ${passed} passed, ${failed} failed, ${skipped} skipped of ${ids.length}`,
);
for (const s of aggregate.scenarios) {
  const icon = s.status === "passed" ? "✓" : s.status === "skipped" ? "∼" : "✗";
  console.error(`  ${icon} ${s.id} (${s.durationMs}ms)`);
}

process.exit(failed > 0 ? 1 : 0);
