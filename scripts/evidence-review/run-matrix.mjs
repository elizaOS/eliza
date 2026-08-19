#!/usr/bin/env node
/**
 * Full evidence matrix runner for end-of-work verification. It executes the
 * repo's real test, recording, audit, and device-capture lanes in sequence,
 * streams each lane's status through the human-speed reporter (reporter.mjs),
 * ingests every producer into one named evidence bundle, verifies its bytes,
 * opens the local reviewer on that exact bundle, and prints a single
 * admin-readable summary of what passed, failed, or was skipped.
 *
 * Device lanes whose simulator/emulator is unreachable are reported `skipped`
 * with a reason (probeRequirement) — never dropped silently and never faked
 * green — so the manifest is an honest record of what actually ran.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMatrixReporter, renderMatrixSummary } from "./reporter.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_BUNDLE_ROOT = path.join(REPO_ROOT, "evidence", "runs");

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
    command: ["node", "scripts/e2e-recordings/run-all.mjs"],
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
    command: ["node", "scripts/e2e-recordings/capture-ios-sim.mjs"],
    tags: ["device", "ios"],
    // Requires a booted iOS Simulator; probed via `xcrun simctl` so the lane is
    // honestly skipped (not silently dropped) on a host without one.
    requires: "ios-simulator",
  },
  {
    id: "android-emu-capture",
    label: "Android emulator capture",
    command: ["node", "scripts/e2e-recordings/capture-android-emu.mjs"],
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
  --out=<dir>              Dashboard output directory. Default: evidence/review/<run-id>.
  --tier=<cpu|gpu|full>    Bundle evidence tier. Default: cpu.
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
    outputDir: null,
    tier: "cpu",
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
    } else if (arg.startsWith("--tier=")) {
      options.tier = arg.slice("--tier=".length);
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
  if (!["cpu", "gpu", "full"].includes(options.tier)) {
    throw new Error("--tier must be cpu, gpu, or full");
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

function writeManifest(options, steps, reviewer, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
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
      tier: options.tier,
    },
    status: steps.some((step) => step.status === "failed")
      ? "failed"
      : options.dryRun
        ? "planned"
        : "passed",
    steps,
    reviewer,
  };
  const manifestPath = path.join(outputDir, "matrix-run.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return { manifest, manifestPath };
}

function commandFailure(label, result) {
  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  return new Error(
    `${label} failed${result.status === null ? " to start" : ` with exit ${result.status}`}${detail ? `\n${detail}` : ""}`,
    result.error ? { cause: result.error } : undefined,
  );
}

/** Capture content hashes for every pre-existing producer artifact. */
export function captureEvidenceBaseline(stagingDir, { run = spawnSync } = {}) {
  const cli = path.join(REPO_ROOT, "packages", "evidence", "src", "cli.ts");
  const baselinePath = path.join(stagingDir, "silo-baseline.json");
  const result = run(
    "bun",
    [cli, "snapshot", "--repo-root", REPO_ROOT, "--out", baselinePath],
    { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env } },
  );
  if (result.error || result.status !== 0) {
    throw commandFailure("evidence baseline capture", result);
  }
  if (!fs.existsSync(baselinePath)) {
    throw new Error("evidence baseline capture did not write its snapshot");
  }
  return baselinePath;
}

/**
 * Create one exact bundle for this matrix report, then run the canonical
 * integrity verifier before returning its directory. Exported so contract tests
 * can prove command ordering without executing the expensive matrix lanes.
 */
export function createVerifiedBundle(
  options,
  matrixManifestPath,
  baselinePath,
  { run = spawnSync } = {},
) {
  const cli = path.join(REPO_ROOT, "packages", "evidence", "src", "cli.ts");
  const created = run(
    "bun",
    [
      cli,
      "create",
      "--tier",
      options.tier,
      "--out",
      DEFAULT_BUNDLE_ROOT,
      "--repo-root",
      REPO_ROOT,
      "--baseline",
      baselinePath,
      "--lane-report",
      `matrix=${matrixManifestPath}`,
      "--json",
    ],
    { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env } },
  );
  if (created.error || created.status !== 0) {
    throw commandFailure("evidence bundle creation", created);
  }
  let payload;
  try {
    payload = JSON.parse(`${created.stdout ?? ""}`);
  } catch (error) {
    throw new Error("evidence bundle creation returned invalid JSON", {
      cause: error,
    });
  }
  if (
    payload?.schema !== 1 ||
    payload?.command !== "bundle:create" ||
    typeof payload.runId !== "string" ||
    typeof payload.bundleDir !== "string" ||
    typeof payload.manifestPath !== "string" ||
    !/^[0-9a-f]{64}$/u.test(payload.manifestSha256)
  ) {
    throw new Error(
      "evidence bundle creation returned an invalid result object",
    );
  }
  const bundleDir = path.resolve(payload.bundleDir);
  const manifestPath = path.resolve(payload.manifestPath);
  if (
    !bundleDir.startsWith(`${DEFAULT_BUNDLE_ROOT}${path.sep}`) ||
    path.basename(bundleDir) !== payload.runId ||
    manifestPath !== path.join(bundleDir, "manifest.json")
  ) {
    throw new Error("evidence bundle creation returned paths outside its run");
  }
  const verified = run("bun", [cli, "verify", bundleDir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env },
  });
  if (verified.error || verified.status !== 0) {
    throw commandFailure("evidence bundle verification", verified);
  }
  return {
    bundleDir,
    manifestPath,
    createOutput: `bundle ${payload.runId}\n  artifacts: ${payload.artifactCount}\n  manifest: ${manifestPath}\n  sha256: ${payload.manifestSha256}`,
    verifyOutput: `${verified.stdout ?? ""}`.trim(),
  };
}

export function runReviewer(options, bundleDir, { run = spawnSync } = {}) {
  if (!options.review || options.dryRun) return null;
  const script = path.join(
    REPO_ROOT,
    "scripts",
    "evidence-review",
    "generate.mjs",
  );
  const outputDir =
    options.outputDir ??
    path.join(REPO_ROOT, "evidence", "review", path.basename(bundleDir));
  const args = [
    script,
    `--bundle=${bundleDir}`,
    `--out=${outputDir}`,
    `--ocr=${options.reviewOcr}`,
    options.open ? "--open" : "--no-open",
  ];
  const result = run(process.execPath, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env },
  });
  return {
    command: `node ${args.join(" ")}`,
    exitCode: result.status ?? 1,
    status: result.status === 0 ? "passed" : "failed",
    dashboardPath: path.join(outputDir, "index.html"),
    bundleDir,
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

  if (options.dryRun) {
    const results = executeSteps(steps, options, { reporter });
    const outputDir =
      options.outputDir ??
      path.join(REPO_ROOT, "evidence", "review", "planned");
    const { manifest, manifestPath } = writeManifest(
      options,
      results,
      null,
      outputDir,
    );
    const summary = renderMatrixSummary(results, {
      manifestPath,
      dashboardPath: null,
    });
    console.log(summary.text);
    if (manifest.status === "failed") process.exit(1);
    return;
  }

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-matrix-"));
  try {
    const baselinePath = captureEvidenceBaseline(stagingDir);
    const results = executeSteps(steps, options, { reporter });
    const { manifestPath: stagedManifest } = writeManifest(
      options,
      results,
      null,
      stagingDir,
    );
    const bundle = createVerifiedBundle(options, stagedManifest, baselinePath);
    console.log(bundle.createOutput);
    console.log(bundle.verifyOutput);
    const reviewer = runReviewer(options, bundle.bundleDir);
    const manifest = {
      status: results.some((step) => step.status === "failed")
        ? "failed"
        : "passed",
    };
    const manifestPath = bundle.manifestPath;

    const summary = renderMatrixSummary(results, {
      manifestPath,
      dashboardPath: reviewer?.dashboardPath ?? null,
    });
    console.log(summary.text);

    if (
      manifest.status === "failed" ||
      (reviewer && reviewer.status === "failed")
    ) {
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
