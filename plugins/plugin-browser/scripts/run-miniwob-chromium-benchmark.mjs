#!/usr/bin/env bun
/**
 * MiniWoB++ browser benchmark runner — REAL Chromium engine (#10333).
 *
 * Runs the same MiniWoB++ task suite as `run-miniwob-benchmark.mjs`, but every
 * action is dispatched through a real Chromium process
 * (`createChromiumBenchmarkExecutor`, puppeteer-core) instead of JSDOM web mode,
 * and writes a run-report artifact. This is the deferred "Needs CI infra"
 * counterpart to the web-mode lane: proof that the benchmark runs end-to-end
 * through plugin-browser BROWSER commands on a real browser engine.
 *
 * Requires a Chromium binary (run `bunx playwright install --with-deps chromium`,
 * or set PUPPETEER_EXECUTABLE_PATH / CHROME_PATH). Skips gracefully (exit 0) when
 * none is available so the un-gated path is a no-op.
 *
 * Usage:
 *   bun scripts/run-miniwob-chromium-benchmark.mjs [--policy oracle|noop|wrong]
 *                                                  [--seeds N] [--out <file>]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createChromiumBenchmarkExecutor,
  launchChromiumBenchmarkBrowser,
  NoopPolicy,
  OraclePolicy,
  resolveChromiumExecutablePath,
  runBenchmarkSuite,
  WrongPolicy,
} from "../src/benchmark/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

function parseArgs(argv) {
  const opts = { policy: "oracle", seeds: 3, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--policy") opts.policy = argv[++i];
    else if (a === "--seeds") opts.seeds = Number(argv[++i]);
    else if (a === "--out") opts.out = argv[++i];
  }
  return opts;
}

function makePolicy(name) {
  if (name === "noop") return new NoopPolicy();
  if (name === "wrong") return new WrongPolicy();
  return new OraclePolicy();
}

async function main() {
  const chromium = resolveChromiumExecutablePath();
  if (!chromium) {
    console.log(
      "[miniwob-chromium] no Chromium binary found — skipping " +
        "(run `bunx playwright install --with-deps chromium` first).",
    );
    return;
  }
  console.log(`[miniwob-chromium] using Chromium at ${chromium}`);

  const opts = parseArgs(process.argv.slice(2));
  const seeds = Array.from({ length: Math.max(1, opts.seeds) }, (_, i) => i);
  const outPath =
    opts.out ??
    path.join(
      repoRoot,
      "test-results/evidence/10333-browser-real-chromium",
      `miniwob-chromium-${opts.policy}-run.json`,
    );

  // One browser for the whole suite — a fresh page per episode is cheap.
  const { browser, close } = await launchChromiumBenchmarkBrowser();
  let report;
  try {
    report = await runBenchmarkSuite({
      seeds,
      policy: makePolicy(opts.policy),
      makeExecutor: () => createChromiumBenchmarkExecutor({ browser }),
    });
  } finally {
    await close();
  }

  // Stamp the artifact after the deterministic run (clock is not part of the run).
  const stamped = { generatedAt: new Date().toISOString(), ...report };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(stamped, null, 2)}\n`);

  console.log(
    `\nMiniWoB++ benchmark — engine=${report.engine} policy=${report.policy}`,
  );
  console.log("─".repeat(64));
  for (const t of report.summary.byTask) {
    const bar = t.solved === t.total ? "✓" : "✗";
    console.log(`  ${bar} ${t.taskId.padEnd(24)} ${t.solved}/${t.total}`);
  }
  console.log("─".repeat(64));
  console.log(
    `  TOTAL solved ${report.summary.solved}/${report.summary.total} ` +
      `(success rate ${(report.summary.successRate * 100).toFixed(1)}%)`,
  );

  const failures = report.episodes.filter((e) => !e.success);
  if (failures.length > 0) {
    console.log("\n  failing episodes:");
    for (const f of failures) {
      const steps = f.trajectory
        .map((s) => `${s.action.type}${s.error ? `!${s.error}` : ""}`)
        .join(" → ");
      console.log(
        `   - ${f.taskId}#${f.seed} reward=${f.reward} steps=[${steps}]` +
          `${f.error ? ` err=${f.error}` : ""}`,
      );
    }
  }
  console.log(`\n  artifact → ${path.relative(repoRoot, outPath)}\n`);

  // Non-zero exit on an unexpected oracle failure so CI catches regressions.
  if (
    opts.policy === "oracle" &&
    report.summary.solved !== report.summary.total
  ) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
