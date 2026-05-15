#!/usr/bin/env node
// eliza1-hf-stage.mjs — Node entry around the Eliza-1 per-tier HF publisher.
//
// Walks every tier in `ELIZA_1_TIERS` (resolved by the Python publisher),
// asks `scripts.publish.publish_eliza1_model_repo` to plan each
// `<bundles-root>/eliza-1-<tier>.bundle/` directory, and prints the
// resulting plan + JSON report. **Dry-run by default** — this script
// never invokes the actual HF upload path. To push, run
// `eliza1-hf-push.sh` with `HF_TOKEN` set AND `--yes-i-will-pay`.
//
// Usage:
//   node packages/training/scripts/publish/eliza1-hf-stage.mjs
//   node packages/training/scripts/publish/eliza1-hf-stage.mjs --dry-run
//   node packages/training/scripts/publish/eliza1-hf-stage.mjs --bundles-root ~/staging
//   node packages/training/scripts/publish/eliza1-hf-stage.mjs --report /tmp/plan.json
//   node packages/training/scripts/publish/eliza1-hf-stage.mjs --tier 0_8b --tier 2b
//
// Exit codes mirror the Python publisher:
//   0 — every tier uploadable (or --allow-missing was passed)
//   2 — at least one tier has unresolved blockers (default behaviour)
//   other — Python launch / interpreter failure

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRAINING_ROOT = resolve(HERE, "..", "..");
const DEFAULT_BUNDLES_ROOT = join(homedir(), ".eliza", "local-inference", "models");

function parseArgs(argv) {
  const out = {
    dryRun: true,
    bundlesRoot: DEFAULT_BUNDLES_ROOT,
    tiers: [],
    report: null,
    allowMissing: true,
    strictVoicePolicy: false,
    skipHashVerify: false,
    extra: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--no-dry-run") {
      out.dryRun = false;
    } else if (arg === "--bundles-root") {
      out.bundlesRoot = argv[++i];
    } else if (arg === "--tier") {
      out.tiers.push(argv[++i]);
    } else if (arg === "--report") {
      out.report = argv[++i];
    } else if (arg === "--no-allow-missing") {
      out.allowMissing = false;
    } else if (arg === "--strict-voice-policy") {
      out.strictVoicePolicy = true;
    } else if (arg === "--skip-hash-verify") {
      out.skipHashVerify = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        `Usage: node eliza1-hf-stage.mjs [--dry-run] [--bundles-root DIR] ` +
          `[--tier TIER]... [--report PATH] [--strict-voice-policy] ` +
          `[--skip-hash-verify] [--no-allow-missing]\n`,
      );
      process.exit(0);
    } else {
      out.extra.push(arg);
    }
  }
  return out;
}

function pickPython() {
  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  process.stderr.write(
    "eliza1-hf-stage: neither python3 nor python is on PATH. " +
      "Install Python 3.12+ (the publish module is Python).\n",
  );
  process.exit(127);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const python = pickPython();

  if (!existsSync(opts.bundlesRoot)) {
    process.stderr.write(
      `eliza1-hf-stage: bundles-root ${opts.bundlesRoot} does not exist. ` +
        `Stage tier bundles first via scripts/publish/stage_base_v1_candidate.py ` +
        `(see packages/training/reports/eliza1-hf-readiness-2026-05-14.md).\n`,
    );
  }

  const args = [
    "-m",
    "scripts.publish.publish_eliza1_model_repo",
    "--bundles-root",
    opts.bundlesRoot,
  ];
  for (const tier of opts.tiers) {
    args.push("--tier", tier);
  }
  if (opts.dryRun) args.push("--dry-run");
  if (opts.allowMissing) args.push("--allow-missing");
  if (opts.strictVoicePolicy) args.push("--strict-voice-policy");
  if (opts.skipHashVerify) args.push("--skip-hash-verify");
  if (opts.report) args.push("--report", opts.report);
  for (const extra of opts.extra) args.push(extra);

  process.stderr.write(
    `eliza1-hf-stage: running ${python} ${args.join(" ")} (cwd=${TRAINING_ROOT})\n`,
  );
  const result = spawnSync(python, args, {
    cwd: TRAINING_ROOT,
    stdio: "inherit",
    env: { ...process.env, PYTHONPATH: TRAINING_ROOT },
  });
  if (result.error) {
    process.stderr.write(`eliza1-hf-stage: ${result.error.message}\n`);
    process.exit(126);
  }
  process.exit(result.status ?? 1);
}

main();
