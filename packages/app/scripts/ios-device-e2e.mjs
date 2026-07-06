#!/usr/bin/env node
/**
 * One-command physical-iPhone e2e lane: build + deploy the current tree to the
 * plugged-in iPhone, assert it boots on-device, capture the filmstrip, pull the
 * boot-trace, and collapse everything into one run-scoped triage bundle whose
 * absolute path is printed as the last line (issue #14337).
 *
 * Chains three already-proven scripts through the pure step-runner in
 * `lib/ios-device-e2e-lib.mjs`:
 *   1. ios-device-deploy.mjs  --skip-appexes  (build → sign → devicectl install;
 *      appex surfaces excluded — logged loudly by the deploy script). The deploy
 *      also writes the renderer-freshness assert + the deploy ledger row.
 *   2. ios-device-capture.mjs --platform device  (BootCapture — the ON-DEVICE
 *      assertion: did the freshly deployed app reach home or the error card?
 *      `mobile-local-chat-smoke` is simulator-only, so BootCapture is the
 *      device assertion of record). Its filmstrip attachments land in smoke/, so
 *      the one on-device boot yields both the verdict and the watchable artifact.
 *   3. ios-device-logs.mjs --no-console --pull-boot-trace  (full-Bun engine
 *      observability; attached --console SIGTRAPs the no-JIT engine, #11515).
 *
 * Every step's exit is loud: a non-zero child fails the lane non-zero. The bundle
 * (research doc 08 Q2/Q3 shape: smoke/ logs/ summary.json) is written under a
 * gitignored run-scoped dir and its path is the final stdout line so an agent
 * can post the smoke filmstrip + boot-trace to a PR.
 *
 * Device id: --device flag or ELIZA_IOS_DEVICE_ID.
 *
 * Usage:
 *   node scripts/ios-device-e2e.mjs [--device <id>] [--skip-appexes]
 *     [--no-skip-appexes] [--skip-logs] [--require-chat]
 *     [--bundle-id <id>] [--output <dir>]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDevicectlDeviceList } from "./ios-device-devicectl.mjs";
import {
  findDeviceRecord,
  parseCliArgs,
  resolveDeviceId,
} from "./ios-device-lib.mjs";
import {
  buildDeviceDeployCommand,
  buildDeviceLogsCommand,
  buildDeviceSmokeCommand,
  buildRunSummary,
  classifyStepStatus,
  formatRunId,
  planIosDeviceE2eSteps,
} from "./lib/ios-device-e2e-lib.mjs";
import {
  freshRendererManifestPath,
  readRendererManifest,
} from "./lib/ios-renderer-stamp.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, "..");
const repoRoot = path.resolve(appRoot, "..", "..");

const log = (message) => console.log(`[ios-device-e2e] ${message}`);
const fail = (message) => {
  console.error(`[ios-device-e2e] ERROR: ${message}`);
  process.exit(1);
};

function runStep(step, { cmd, args }) {
  log(`${step.id}: ${step.label}`);
  log(`  $ ${cmd} ${args.join(" ")}`);
  const startedAt = Date.now();
  const result = spawnSync(cmd, args, { cwd: appRoot, stdio: "inherit" });
  const durationMs = Date.now() - startedAt;
  const verdict = classifyStepStatus(result.status);
  return { verdict, durationMs, status: result.status };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    booleans: [
      "skip-appexes",
      "no-skip-appexes",
      "skip-logs",
      "require-chat",
      "help",
    ],
  });
  if (args.help) {
    console.log(
      "Usage: node scripts/ios-device-e2e.mjs [--device <id>] [--no-skip-appexes] [--skip-logs] [--require-chat] [--bundle-id <id>] [--output <dir>]",
    );
    return;
  }
  if (process.platform !== "darwin") fail("iOS device e2e requires macOS.");

  const deviceId = resolveDeviceId({ flagValue: args.device ?? null });
  if (!deviceId) {
    fail(
      "no device given. Pass --device <devicectl-id|udid|name> or set ELIZA_IOS_DEVICE_ID.\n" +
        "List devices with: xcrun devicectl list devices",
    );
  }
  const device = findDeviceRecord(readDevicectlDeviceList(), deviceId);
  if (!device) {
    fail(
      `device "${deviceId}" not found via devicectl. List: xcrun devicectl list devices ` +
        "(pair the phone: Finder → device → Trust, and enable Developer Mode).",
    );
  }
  log(
    `device: ${device.name} (identifier ${device.identifier}, udid ${device.udid})`,
  );

  // --skip-appexes is the default unattended posture (PR #13174); --no-skip-appexes
  // opts back in when per-appex profiles exist.
  const skipAppexes = !args["no-skip-appexes"];
  const bundleId = args["bundle-id"] || null;

  const runId = formatRunId();
  const startedAtIso = new Date().toISOString();
  const bundleDir = path.resolve(
    args.output || path.join(appRoot, "device-e2e-output", `ios-${runId}`),
  );
  const smokeDir = path.join(bundleDir, "smoke");
  const logsDir = path.join(bundleDir, "logs");
  for (const dir of [bundleDir, smokeDir, logsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const steps = planIosDeviceE2eSteps({
    skipLogs: Boolean(args["skip-logs"]),
  });
  log(`plan: ${steps.map((s) => s.id).join(" → ")}`);
  log(`bundle: ${bundleDir}`);

  const commandFor = (step) => {
    switch (step.id) {
      case "deploy":
        return {
          command: buildDeviceDeployCommand({
            scriptsDir,
            deviceId,
            skipAppexes,
            bundleId,
          }),
          artifacts: [],
        };
      case "smoke":
        return {
          command: buildDeviceSmokeCommand({
            scriptsDir,
            deviceId,
            outputDir: smokeDir,
            requireChat: Boolean(args["require-chat"]),
            bundleId,
          }),
          artifacts: [smokeDir],
        };
      case "logs":
        return {
          command: buildDeviceLogsCommand({
            scriptsDir,
            deviceId,
            // ios-device-logs derives its own trace filename from
            // path.dirname(--output), so point --output at a file inside logsDir.
            outputFile: path.join(logsDir, "boot-trace-run"),
            bundleId,
          }),
          artifacts: [logsDir],
        };
      default:
        throw new Error(`unknown step: ${step.id}`);
    }
  };

  const recorded = [];
  let firstFailure = null;
  for (const step of steps) {
    const { command, artifacts } = commandFor(step);
    const { verdict, durationMs } = runStep(step, command);
    recorded.push({
      id: step.id,
      label: step.label,
      status: verdict.status,
      durationMs,
      artifacts,
    });
    if (!verdict.ok) {
      firstFailure = step.id;
      break;
    }
  }

  // The deploy step writes the renderer stamp into the ledger; surface the
  // buildId/commit into the summary by reading the freshly built dist stamp
  // (the exact bundle the deploy installed). A missing stamp is not fatal to
  // the summary — the deploy step's own assert already gated on it — so this is
  // best-effort metadata, recorded as null when unreadable.
  let build = { buildId: null, commit: null };
  try {
    const fresh = readRendererManifest(
      freshRendererManifestPath({ repoRoot }),
      "freshly built",
    );
    build = { buildId: fresh.buildId, commit: fresh.commit };
  } catch (error) {
    // error-policy:J7 diagnostics-must-not-kill-the-loop — the summary's build
    // metadata is informational; the deploy already asserted freshness. Warn
    // and record null rather than failing an otherwise-complete run.
    log(`summary build metadata unavailable: ${error?.message ?? error}`);
  }

  const summary = buildRunSummary({
    runId,
    startedAt: startedAtIso,
    finishedAt: new Date().toISOString(),
    bundleDir,
    device,
    build,
    skippedAppexes: skipAppexes,
    steps: recorded,
  });
  const summaryPath = path.join(bundleDir, "summary.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  if (firstFailure) {
    log(`FAILED at step "${firstFailure}". Bundle (partial) written.`);
    // The bundle path is the machine-readable handoff even on failure.
    console.log(bundleDir);
    process.exit(1);
  }

  log(
    `ALL iOS DEVICE E2E PASSED ✅ (${skipAppexes ? "appexes SKIPPED — widget/keyboard/device-activity surfaces UNTESTED" : "appexes included"})`,
  );
  // Last line: the absolute bundle path (contract with #14337 — agents post the
  // smoke/ filmstrip + logs/ boot-trace inline to the PR).
  console.log(bundleDir);
}

main().catch((error) => fail(error?.stack ?? String(error)));
