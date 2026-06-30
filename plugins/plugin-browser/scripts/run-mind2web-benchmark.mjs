#!/usr/bin/env bun
/**
 * Mind2Web replay benchmark runner — REAL Chromium (#10333).
 *
 * Replays a Mind2Web-format action sequence (CLICK / TYPE / SELECT) through the
 * REAL plugin-browser BROWSER command surface on a real Chromium and writes a
 * run-report artifact — proof that Mind2Web actions execute end-to-end through
 * plugin-browser, not the inference-layer bypass in
 * `packages/benchmarks/mind2web/eliza_agent.py`.
 *
 * Runs the embedded fixture by default; set `MIND2WEB_DATA_DIR` to a directory of
 * converted Mind2Web task JSON to drive the real corpus. Skips gracefully when no
 * Chromium binary is available.
 *
 * Usage: bun scripts/run-mind2web-benchmark.mjs [--out <file>]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createChromiumBenchmarkExecutor,
  launchChromiumBenchmarkBrowser,
  loadMind2WebTasks,
  resolveChromiumExecutablePath,
  runMind2WebSuite,
} from "../src/benchmark/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

function parseArgs(argv) {
  const opts = { out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") opts.out = argv[++i];
  }
  return opts;
}

async function main() {
  const chromium = resolveChromiumExecutablePath();
  if (!chromium) {
    console.log(
      "[mind2web] no Chromium binary found — skipping " +
        "(run `bunx playwright install --with-deps chromium` first).",
    );
    return;
  }
  console.log(`[mind2web] using Chromium at ${chromium}`);
  const opts = parseArgs(process.argv.slice(2));
  const outPath =
    opts.out ??
    path.join(
      repoRoot,
      ".github/issue-evidence/10333-browser-real-chromium",
      "mind2web-chromium-run.json",
    );

  const { tasks, source } = loadMind2WebTasks();
  const { browser, close } = await launchChromiumBenchmarkBrowser();
  let report;
  try {
    const { executor, dispose } = await createChromiumBenchmarkExecutor({
      browser,
    });
    try {
      report = await runMind2WebSuite(executor, tasks, source);
    } finally {
      await dispose();
    }
  } finally {
    await close();
  }

  const stamped = { generatedAt: new Date().toISOString(), ...report };
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(stamped, null, 2)}\n`);

  console.log(
    `\nMind2Web replay — engine=${report.engine} source=${report.source}`,
  );
  console.log("─".repeat(64));
  for (const t of report.tasks) {
    const bar = t.success ? "✓" : "✗";
    console.log(
      `  ${bar} ${t.taskId.padEnd(24)} steps ${t.verifiedSteps}/${t.totalSteps}` +
        ` (${(t.stepAccuracy * 100).toFixed(0)}%)`,
    );
  }
  console.log("─".repeat(64));
  console.log(
    `  TASKS solved ${report.summary.solved}/${report.summary.tasks}, ` +
      `step accuracy ${(report.summary.stepAccuracy * 100).toFixed(1)}% ` +
      `(${report.summary.verifiedSteps}/${report.summary.totalSteps})`,
  );
  console.log(`\n  artifact → ${path.relative(repoRoot, outPath)}\n`);

  if (report.summary.stepAccuracy !== 1) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
