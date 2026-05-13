#!/usr/bin/env node
/**
 * Promote model eval collector reports into the top-level Eliza-1 release gate.
 *
 * This script never turns needs-data into a pass. It runs the existing
 * per-tier collector, reads its release matrix, and writes one aggregate
 * eliza1_quality_perf_evals artifact only when every requested tier is
 * non-blocking and has no blocking failures.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const DEFAULT_EVIDENCE_DIR = path.join(
  REPO_ROOT,
  "reports",
  "eliza1-release-gates",
);
const DEFAULT_TIERS = ["2b", "9b", "27b"];

function parseArgs(argv) {
  const args = {
    tiers: DEFAULT_TIERS,
    evidenceDir: DEFAULT_EVIDENCE_DIR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--tiers") {
      args.tiers = next()
        .split(",")
        .map((tier) => tier.trim())
        .filter(Boolean);
    } else if (arg === "--evidence-dir") {
      args.evidenceDir = path.resolve(next());
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/eliza1-quality-perf-evidence.mjs [--tiers 2b,9b,27b] [--evidence-dir DIR]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.tiers.length === 0)
    throw new Error("--tiers must include at least one tier");
  return args;
}

function timestampForFile() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function runCollector(tier) {
  const output = execFileSync(
    "node",
    [
      "packages/inference/verify/eliza1_gates_collect.mjs",
      "--tier",
      tier,
      "--json",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(output);
}

function writeEvidence(args, evidence) {
  fs.mkdirSync(args.evidenceDir, { recursive: true });
  const file = path.join(
    args.evidenceDir,
    `eliza1_quality_perf_evals-${timestampForFile()}.json`,
  );
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    `[eliza1:quality-perf] wrote ${path.relative(REPO_ROOT, file)} (${evidence.status})`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reports = args.tiers.map((tier) => runCollector(tier));
  const blockers = reports.flatMap((report) =>
    (report.releaseMatrixSummary?.blockerReasons ?? []).map((reason) => ({
      tier: report.tier,
      reason,
    })),
  );
  const gatesPassed =
    reports.length === args.tiers.length &&
    reports.every((report) => report.releaseMatrixSummary?.blocking === false);
  const evidence = {
    gate: "eliza1_quality_perf_evals",
    status: gatesPassed ? "pass" : "fail",
    completedAt: new Date().toISOString(),
    tiers: reports.map((report) => report.tier),
    gatesPassed,
    reportPath: reports.map((report) => report.reportPath).join(","),
    reports: reports.map((report) => ({
      tier: report.tier,
      reportPath: report.reportPath,
      releaseMatrixSummary: report.releaseMatrixSummary,
      summary: report.summary,
    })),
    blockers,
    summary: gatesPassed
      ? `Eliza-1 quality/perf gates passed for ${args.tiers.join(", ")}`
      : `Eliza-1 quality/perf gates still blocked: ${blockers.length} blocking reasons`,
  };
  writeEvidence(args, evidence);
  if (!gatesPassed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[eliza1:quality-perf] ${error.message}`);
  process.exit(1);
});
