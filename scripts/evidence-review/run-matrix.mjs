#!/usr/bin/env node
/**
 * Full evidence matrix runner for end-of-work verification. It executes the
 * repo's real test, recording, audit, and device-capture lanes in sequence,
 * streams each lane's status through the human-speed reporter (reporter.mjs) so
 * an operator watches the run advance, writes one run manifest, opens the local
 * evidence reviewer, and prints a single admin-readable summary of what passed,
 * failed, or was skipped and where the artifacts landed.
 *
 * Device lanes whose simulator/emulator is unreachable are reported `skipped`
 * with a reason (probeRequirement) — never dropped silently and never faked
 * green — so the manifest is an honest record of what actually ran.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMatrixReporter, renderMatrixSummary } from "./reporter.mjs";

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
    // Requires a booted iOS Simulator; probed via `xcrun simctl` so the lane is
    // honestly skipped (not silently dropped) on a host without one.
    requires: "ios-simulator",
  },
  {
    id: "android-emu-capture",
    label: "Android emulator capture",
    command: ["bun", "run", "--cwd", "packages/app", "capture:android-emu"],
    tags: ["device", "android"],
    requires: "android-emulator",
  },
];

/**
 * Report whether a lane's external dependency (a device fleet member) is
 * reachable. Returns `{ reachable, reason }`; `reason` is the operator-facing
 * skip explanation when a device is absent. Kept side-effect-free apart from the
 * cheap probe command so device lanes degrade to an honest SKIP rather than a
 * fake pass or a silent drop.
 */
export function probeRequirement(requirement, { runProbe = spawnSync } = {}) {
  if (!requirement) return { reachable: true, reason: null };
  if (requirement === "ios-simulator") {
    const result = runProbe("xcrun", ["simctl", "list", "devices", "booted"], {
      encoding: "utf8",
    });
    const out = `${result.stdout ?? ""}`;
    if (result.status === 0 && /\(Booted\)/.test(out)) {
      return { reachable: true, reason: null };
    }
    return {
      reachable: false,
      reason: "no booted iOS Simulator (run `xcrun simctl boot <udid>`)",
    };
  }
  if (requirement === "android-emulator") {
    const result = runProbe("adb", ["devices"], { encoding: "utf8" });
    const out = `${result.stdout ?? ""}`;
    const hasDevice = out
      .split("\n")
      .slice(1)
      .some((line) => /\tdevice$/.test(line.trim()));
    if (result.status === 0 && hasDevice) {
      return { reachable: true, reason: null };
    }
    return {
      reachable: false,
      reason:
        "no attached Android device/emulator (run `emulator -avd <name>`)",
    };
  }
  return {
    reachable: false,
    reason: `unknown requirement '${requirement}'`,
  };
}

function printHelp() {
  console.log(`Usage: node scripts/evidence-review/run-matrix.mjs [options]

Options:
  --only=<ids>             Comma-separated step ids to run.
  --skip-devices           Skip iOS/Android device capture lanes.
  --out=<dir>              Output directory for matrix-run.json and reviewer.
  --review / --no-review   Generate the evidence reviewer after the matrix.
  --open / --no-open       Open the reviewer after generation. Default: no-open.
  --review-ocr=on          OCR mode passed to evidence:review. Packaged OCR is required.
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
    reviewOcr: "on",
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

  if (options.reviewOcr !== "on") {
    throw new Error(
      "--review-ocr must be on; OCR is required for evidence review and uses the packaged tesseract.js dependency",
    );
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

  // A filter combination that selects nothing (e.g. `--skip-devices
  // --only=ios-sim-capture`) is an operator mistake, not a passing run. Fail
  // here with an actionable message instead of letting the empty set reach the
  // reporter, which would throw the opaque "positive integer total" error.
  if (selected.length === 0) {
    throw new Error(
      "no lanes selected - check --only/--skip filters (they exclude every matrix step)",
    );
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

function skippedStep(step, reason) {
  return {
    ...step,
    command: formatCommand(step.command),
    startedAt: null,
    finishedAt: null,
    durationMs: 0,
    exitCode: null,
    status: "skipped",
    skipReason: reason,
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

/**
 * Execute the selected lanes, driving the streaming reporter through each
 * lane's lifecycle. Device lanes whose requirement is unreachable are recorded
 * as `skipped` with the probe reason rather than run. Extracted from main() so
 * the ordering of reporter transitions and lane records is unit-testable with
 * injected reporter and probe.
 */
export function executeSteps(
  steps,
  options,
  { reporter, probe = probeRequirement } = {},
) {
  const results = [];
  for (const step of steps) {
    if (options.dryRun) {
      results.push(plannedStep(step));
      continue;
    }

    const requirement = probe(step.requires);
    if (!requirement.reachable) {
      reporter?.laneSkip(step, requirement.reason);
      results.push(skippedStep(step, requirement.reason));
      continue;
    }

    reporter?.laneStart(step);
    const result = runStep(step);
    reporter?.laneEnd(step, result.status);
    results.push(result);
    if (result.status === "failed" && options.stopOnFailure) break;
  }
  return results;
}

async function main() {
  const options = parseMatrixArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const steps = selectMatrixSteps(MATRIX_STEPS, options);

  let reporter = null;
  if (!options.dryRun) {
    reporter = createMatrixReporter({
      write: (line) => console.log(line),
      total: steps.length,
    });
    reporter.header();
  }

  const results = executeSteps(steps, options, { reporter });

  writeManifest(options, results, null);
  const reviewer = runReviewer(options);
  const { manifest, manifestPath } = writeManifest(options, results, reviewer);

  const summary = renderMatrixSummary(results, {
    manifestPath,
    dashboardPath: reviewer?.dashboardPath ?? null,
  });
  console.log(summary.text);

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
