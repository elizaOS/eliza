#!/usr/bin/env node
/**
 * Full evidence matrix runner for end-of-work verification. It executes the
 * repo's real test, recording, audit, and device-capture lanes in sequence,
 * writes one run manifest, then opens the local evidence reviewer so the
 * generated artifacts are inspected as part of the same workflow.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "evidence");

export const MATRIX_STEPS = [
  {
    id: "test-all",
    label: "Unit, integration, and e2e test matrix",
    command: ["node", "packages/scripts/run-all-tests.mjs", "--all"],
    tags: ["tests"],
  },
  {
    id: "e2e-recordings",
    label: "Recorded UI e2e sweep",
    command: ["node", "scripts/e2e-recordings/run-all.mjs", "--review"],
    tags: ["ui", "recordings"],
  },
  {
    id: "app-audit",
    label: "App visual audit",
    command: ["bun", "run", "--cwd", "packages/app", "audit:app"],
    tags: ["ui", "screenshots"],
  },
  {
    id: "ios-sim-capture",
    label: "iOS simulator capture",
    command: ["bun", "run", "--cwd", "packages/app", "capture:ios-sim"],
    tags: ["device", "ios"],
  },
  {
    id: "android-emu-capture",
    label: "Android emulator capture",
    command: ["bun", "run", "--cwd", "packages/app", "capture:android-emu"],
    tags: ["device", "android"],
  },
];

function printHelp() {
  console.log(`Usage: node scripts/evidence-review/run-matrix.mjs [options]

Options:
  --only=<ids>             Comma-separated step ids to run.
  --skip-devices           Skip iOS/Android device capture lanes.
  --out=<dir>              Output directory for matrix-run.json and reviewer.
  --review / --no-review   Generate the evidence reviewer after the matrix.
  --open / --no-open       Open the reviewer after generation. Default: no-open.
  --review-ocr=auto|on|off OCR mode passed to evidence:review. Default: off.
  --stop-on-failure        Stop after the first failed step.
  --dry-run                Write a planned manifest without executing commands.
  --help, -h               Show this help.`);
}

export function parseMatrixArgs(argv) {
  const options = {
    only: null,
    skipDevices: false,
    outputDir: DEFAULT_OUTPUT_DIR,
    review: true,
    open: false,
    reviewOcr: "off",
    stopOnFailure: false,
    dryRun: false,
  };

  for (const arg of argv) {
    if (arg === "--skip-devices") options.skipDevices = true;
    else if (arg === "--review") options.review = true;
    else if (arg === "--no-review") options.review = false;
    else if (arg === "--open") options.open = true;
    else if (arg === "--no-open") options.open = false;
    else if (arg === "--stop-on-failure") options.stopOnFailure = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--only=")) {
      options.only = arg
        .slice("--only=".length)
        .split(",")
        .map((step) => step.trim())
        .filter(Boolean);
    } else if (arg.startsWith("--out=")) {
      options.outputDir = path.resolve(REPO_ROOT, arg.slice("--out=".length));
    } else if (arg.startsWith("--review-ocr=")) {
      options.reviewOcr = arg.slice("--review-ocr=".length);
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!["auto", "on", "off"].includes(options.reviewOcr)) {
    throw new Error("--review-ocr must be auto, on, or off");
  }
  return options;
}

export function selectMatrixSteps(steps, options) {
  const selected = steps.filter((step) => {
    if (options.skipDevices && step.tags.includes("device")) return false;
    if (options.only) return options.only.includes(step.id);
    return true;
  });

  if (options.only) {
    const known = new Set(steps.map((step) => step.id));
    const unknown = options.only.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(`unknown matrix step(s): ${unknown.join(", ")}`);
    }
  }
  return selected;
}

function resolveCommand(command) {
  const [bin, ...args] = command;
  return [bin === "node" ? process.execPath : bin, args];
}

function formatCommand(command) {
  return command.join(" ");
}

function runStep(step) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const [bin, args] = resolveCommand(step.command);
  const result = spawnSync(bin, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env },
  });
  const exitCode = result.status ?? 1;
  return {
    ...step,
    command: formatCommand(step.command),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    exitCode,
    status: exitCode === 0 ? "passed" : "failed",
  };
}

function plannedStep(step) {
  return {
    ...step,
    command: formatCommand(step.command),
    startedAt: null,
    finishedAt: null,
    durationMs: 0,
    exitCode: null,
    status: "planned",
  };
}

function writeManifest(options, steps, reviewer) {
  fs.mkdirSync(options.outputDir, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    outputDir: options.outputDir,
    options: {
      skipDevices: options.skipDevices,
      only: options.only,
      review: options.review,
      open: options.open,
      reviewOcr: options.reviewOcr,
      stopOnFailure: options.stopOnFailure,
      dryRun: options.dryRun,
    },
    status: steps.some((step) => step.status === "failed")
      ? "failed"
      : options.dryRun
        ? "planned"
        : "passed",
    steps,
    reviewer,
  };
  const manifestPath = path.join(options.outputDir, "matrix-run.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return { manifest, manifestPath };
}

function runReviewer(options) {
  if (!options.review || options.dryRun) return null;
  const script = path.join(
    REPO_ROOT,
    "scripts",
    "evidence-review",
    "generate.mjs",
  );
  const args = [
    script,
    `--out=${options.outputDir}`,
    `--ocr=${options.reviewOcr}`,
    options.open ? "--open" : "--no-open",
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env },
  });
  return {
    command: `node ${args.join(" ")}`,
    exitCode: result.status ?? 1,
    status: result.status === 0 ? "passed" : "failed",
    dashboardPath: path.join(options.outputDir, "index.html"),
  };
}

function banner(text) {
  const line = "-".repeat(72);
  console.log(`\n${line}\n${text}\n${line}`);
}

async function main() {
  const options = parseMatrixArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const steps = selectMatrixSteps(MATRIX_STEPS, options);
  const results = [];

  if (options.dryRun) {
    for (const step of steps) results.push(plannedStep(step));
  } else {
    for (const step of steps) {
      banner(`${step.id}: ${step.label}`);
      const result = runStep(step);
      results.push(result);
      if (result.status === "failed" && options.stopOnFailure) break;
    }
  }

  writeManifest(options, results, null);
  const reviewer = runReviewer(options);
  const { manifest, manifestPath } = writeManifest(options, results, reviewer);
  console.log(`\nMatrix manifest: ${manifestPath}`);
  if (reviewer?.dashboardPath) {
    console.log(`Evidence review: ${reviewer.dashboardPath}`);
  }

  if (
    manifest.status === "failed" ||
    (reviewer && reviewer.status === "failed")
  ) {
    process.exit(1);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
