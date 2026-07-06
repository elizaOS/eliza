#!/usr/bin/env bun
/**
 * MiniWoB++ browser benchmark runner (#9476).
 *
 * Runs the MiniWoB++ task suite through the REAL plugin-browser command router
 * (`executeBrowserWorkspaceCommand`, web mode) and writes a run-report artifact.
 * This is the plugin-browser analog of plugin-computeruse's OSWorld benchmark
 * runner — proof that a web-interaction benchmark is wired end-to-end through
 * plugin-browser BROWSER actions, not bypassing it via the inference layer.
 *
 * Usage:
 *   bun scripts/run-miniwob-benchmark.mjs [--policy oracle|noop|wrong]
 *                                         [--seeds N] [--out <file>]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NoopPolicy,
  OraclePolicy,
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
  const opts = parseArgs(process.argv.slice(2));
  const seeds = Array.from({ length: Math.max(1, opts.seeds) }, (_, i) => i);
  const outPath =
    opts.out ??
    path.join(
      repoRoot,
      "test-results/evidence/9476-browser-benchmark",
      `miniwob-${opts.policy}-run.json`,
    );

  const report = await runBenchmarkSuite({
    seeds,
    policy: makePolicy(opts.policy),
  });

  // Stamp the artifact after the deterministic run (clock is not part of the run).
  const stamped = { generatedAt: new Date().toISOString(), ...report };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(stamped, null, 2)}\n`);

  // Human-readable summary.
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
