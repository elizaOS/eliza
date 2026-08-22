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
 *   bun packages/scripts/run-scenarios-isolated.mjs <scenarios-dir> [--report <path>]
 *
 * Env:
 *   Same as the underlying CLI (GROQ_API_KEY / OPENAI_API_KEY / etc.).
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveScenarioIsolatedPaths() {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  return {
    repoRoot,
    cli: path.join(repoRoot, "packages", "scenario-runner", "src", "cli.ts"),
  };
}

const { repoRoot: REPO_ROOT, cli: CLI } = resolveScenarioIsolatedPaths();

if (process.argv.includes("--print-paths")) {
  console.log(JSON.stringify({ repoRoot: REPO_ROOT, cli: CLI }));
  process.exit(0);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: run-scenarios-isolated.mjs <dir> [--report <path>]");
  process.exit(2);
}

const dir = path.resolve(args[0]);
let reportPath = null;
let workers = Math.min(4, Math.max(1, os.availableParallelism()));
let timeoutMs = 15 * 60 * 1000;
const forwardedArgs = [];
for (let i = 1; i < args.length; i += 1) {
  if (args[i] === "--report" && args[i + 1]) {
    reportPath = path.resolve(args[i + 1]);
    i += 1;
  } else if (args[i] === "--workers" && args[i + 1]) {
    workers = Number(args[i + 1]);
    i += 1;
  } else if (args[i] === "--timeout-ms" && args[i + 1]) {
    timeoutMs = Number(args[i + 1]);
    i += 1;
  } else {
    forwardedArgs.push(args[i]);
  }
}

if (!Number.isSafeInteger(workers) || workers < 1 || workers > 32) {
  console.error("[isolated] --workers must be an integer from 1 through 32");
  process.exit(2);
}
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
  console.error("[isolated] --timeout-ms must be an integer of at least 1000");
  process.exit(2);
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

// 2. Run each scenario in a unique directory and bounded worker process.
const runRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "scenario-isolated-run-"),
);
const perRunReports = new Array(ids.length).fill(null);
const startedAtIso = new Date().toISOString();
let passed = 0;
let failed = 0;
let skipped = 0;
const activeChildren = new Set();
let interruptedSignal = null;

function stopChildren(signal) {
  interruptedSignal = signal;
  for (const child of activeChildren) child.kill("SIGTERM");
}

process.once("SIGINT", () => stopChildren("SIGINT"));
process.once("SIGTERM", () => stopChildren("SIGTERM"));

function runOne(id, index) {
  return new Promise((resolve) => {
    const safeId = id.replace(/[^a-z0-9._-]/gi, "_");
    const scenarioDir = path.join(
      runRoot,
      `${String(index).padStart(5, "0")}-${safeId}`,
    );
    fs.mkdirSync(scenarioDir, { recursive: true });
    const tmpReport = path.join(scenarioDir, "report.json");
    const child = spawn(
      "bun",
      [
        CLI,
        "run",
        dir,
        "--scenario",
        id,
        "--report",
        tmpReport,
        "--run-dir",
        scenarioDir,
        ...forwardedArgs,
      ],
      {
        cwd: REPO_ROOT,
        stdio: ["inherit", "inherit", "inherit"],
        env: process.env,
      },
    );
    activeChildren.add(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    timer.unref();

    child.once("error", (error) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve({ id, index, ok: false, cause: `spawn error ${error.message}` });
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      if (status !== 0) {
        const cause = timedOut
          ? `timeout after ${timeoutMs}ms`
          : status === null
            ? `signal ${signal ?? "unknown"}`
            : `exit ${status}`;
        resolve({ id, index, ok: false, cause });
        return;
      }
      if (!fs.existsSync(tmpReport)) {
        resolve({
          id,
          index,
          ok: false,
          cause: `produced no report (exit ${status})`,
        });
        return;
      }
      try {
        resolve({
          id,
          index,
          ok: true,
          report: JSON.parse(fs.readFileSync(tmpReport, "utf8")),
        });
      } catch (error) {
        resolve({
          id,
          index,
          ok: false,
          cause: `report parse failed: ${error.message}`,
        });
      }
    });
  });
}

let nextIndex = 0;
async function worker() {
  while (nextIndex < ids.length && interruptedSignal === null) {
    const index = nextIndex;
    nextIndex += 1;
    const id = ids[index];
    const result = await runOne(id, index);
    if (!result.ok) {
      console.error(`[isolated] ${id} failed (${result.cause})`);
      failed += 1;
      continue;
    }
    perRunReports[index] = result.report;
    const scenario = (result.report.scenarios ?? [])[0];
    if (!scenario || scenario.id !== id) {
      console.error(
        `[isolated] ${id} returned a missing or mismatched scenario record`,
      );
      failed += 1;
    } else if (scenario.status === "passed") {
      passed += 1;
    } else if (scenario.status === "skipped") {
      skipped += 1;
    } else {
      failed += 1;
    }
  }
}

await Promise.all(
  Array.from({ length: Math.min(workers, ids.length) }, () => worker()),
);

if (interruptedSignal !== null) {
  failed += ids.length - passed - failed - skipped;
}

const completedAtIso = new Date().toISOString();

// 3. Aggregate into a single report.
const aggregate = {
  runId: `isolated-${Date.now()}`,
  providerName: perRunReports.find(Boolean)?.providerName ?? "unknown",
  startedAtIso,
  completedAtIso,
  totals: { passed, failed, skipped, total: ids.length },
  scenarios: perRunReports.flatMap((r) => r?.scenarios ?? []),
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

fs.rmSync(runRoot, { recursive: true, force: true });

if (interruptedSignal !== null) {
  process.kill(process.pid, interruptedSignal);
} else {
  process.exit(failed > 0 ? 1 : 0);
}
