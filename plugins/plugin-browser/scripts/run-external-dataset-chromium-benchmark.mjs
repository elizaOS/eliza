#!/usr/bin/env bun
/**
 * External browser dataset benchmark runner - REAL Chromium engine (#10333).
 *
 * Runs the committed Mind2Web/WebArena-style external dataset records through
 * the real Chromium benchmark executor and writes an evidence artifact.
 * This complements `bench:external`, which keeps the JSDOM web-mode lane fast
 * for regular package tests.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createChromiumBenchmarkExecutor,
  EXTERNAL_WEB_DATASET_TASKS,
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
  const opts = { policy: "oracle", out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--policy") opts.policy = argv[++i];
    else if (arg === "--out") opts.out = argv[++i];
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
      "[external-chromium] no Chromium binary found - skipping " +
        "(run `bunx playwright install --with-deps chromium` first).",
    );
    return;
  }
  console.log(`[external-chromium] using Chromium at ${chromium}`);

  const opts = parseArgs(process.argv.slice(2));
  const outPath =
    opts.out ??
    path.join(
      repoRoot,
      "test-results/evidence/10333-browser-external-dataset",
      `external-dataset-chromium-${opts.policy}-run.json`,
    );

  const { browser, close } = await launchChromiumBenchmarkBrowser();
  let report;
  try {
    report = await runBenchmarkSuite({
      benchmarkName: "external-web-dataset",
      tasks: EXTERNAL_WEB_DATASET_TASKS,
      seeds: [0],
      policy: makePolicy(opts.policy),
      makeExecutor: () => createChromiumBenchmarkExecutor({ browser }),
    });
  } finally {
    await close();
  }

  const stamped = { generatedAt: new Date().toISOString(), ...report };
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(stamped, null, 2)}\n`);

  console.log(
    `\nExternal dataset benchmark - engine=${report.engine} policy=${report.policy}`,
  );
  console.log("-".repeat(64));
  for (const task of report.summary.byTask) {
    const mark = task.solved === task.total ? "PASS" : "FAIL";
    console.log(
      `  ${mark} ${task.taskId.padEnd(28)} ${task.solved}/${task.total}`,
    );
  }
  console.log("-".repeat(64));
  console.log(
    `  TOTAL solved ${report.summary.solved}/${report.summary.total} ` +
      `(success rate ${(report.summary.successRate * 100).toFixed(1)}%)`,
  );
  console.log(`\n  artifact -> ${path.relative(repoRoot, outPath)}\n`);

  if (
    opts.policy === "oracle" &&
    report.summary.solved !== report.summary.total
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
