#!/usr/bin/env bun
/**
 * MiniWoB++ browser benchmark — REAL Chromium engine runner (#10333 / #9476).
 *
 * Runs the same MiniWoB++ suite as `run-miniwob-benchmark.mjs`, but against a
 * real Chromium engine (Edge/Chrome via puppeteer-core) instead of JSDOM web
 * mode — the deferred "real-engine lane". Writes a run-report artifact.
 *
 * Requires a Chromium binary (auto-detected, or PUPPETEER_EXECUTABLE_PATH).
 * Usage: bun scripts/run-miniwob-chromium.mjs [--seeds N] [--out <file>]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createChromiumBenchmarkExecutor,
  OraclePolicy,
  resolveChromiumExecutable,
  runBenchmarkSuite,
} from "../src/benchmark/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

function parseArgs(argv) {
  const opts = { seeds: 3, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seeds") opts.seeds = Number(argv[++i]);
    else if (argv[i] === "--out") opts.out = argv[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const exe = resolveChromiumExecutable();
  if (!exe) {
    console.error(
      "No Chromium binary found. Set PUPPETEER_EXECUTABLE_PATH / BENCHMARK_CHROMIUM_PATH.",
    );
    process.exit(2);
  }
  console.log(`Using Chromium: ${exe}`);

  const seeds = Array.from({ length: Math.max(1, opts.seeds) }, (_, i) => i);
  const outPath =
    opts.out ??
    path.join(
      repoRoot,
      ".github/issue-evidence/9476-browser-benchmark",
      "miniwob-chromium-run.json",
    );

  // One real browser shared across episodes (launch is expensive); a no-op
  // per-episode disposer keeps it alive, and we close it once at the end.
  const chromium = await createChromiumBenchmarkExecutor({ headless: true });
  let report;
  try {
    report = await runBenchmarkSuite({
      seeds,
      policy: new OraclePolicy(),
      makeExecutor: async () => ({
        executor: chromium.executor,
        dispose: async () => {},
      }),
    });
  } finally {
    await chromium.dispose();
  }

  const stamped = {
    generatedAt: new Date().toISOString(),
    chromiumExecutable: exe,
    ...report,
  };
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(stamped, null, 2)}\n`);

  console.log(`\nMiniWoB++ — engine=${report.engine} policy=${report.policy}`);
  console.log("─".repeat(56));
  for (const t of report.summary.byTask) {
    console.log(
      `  ${t.solved === t.total ? "✓" : "✗"} ${t.taskId.padEnd(22)} ${t.solved}/${t.total}`,
    );
  }
  console.log("─".repeat(56));
  console.log(
    `  TOTAL ${report.summary.solved}/${report.summary.total} (${(report.summary.successRate * 100).toFixed(1)}%)`,
  );
  console.log(`  artifact → ${path.relative(repoRoot, outPath)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
