#!/usr/bin/env node
/**
 * One-command physical-iPhone e2e lane: build + deploy the current tree to the
 * plugged-in iPhone, assert it boots on-device, capture the filmstrip, pull the
 * boot-trace, and collapse everything into one run-scoped triage bundle whose
 * absolute path is printed as the last line (issue #14337).
 *
 * Chains three already-proven scripts through the argv builders in
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
 * Run assembly — per-step timing, artifact collection, PNG→JPG / MOV→MP4 inline
 * conversion, junit, and the machine-readable `summary.json` — goes through the
 * shared `lib/device-e2e-bundle.mjs` framework, the same one `android-e2e.mjs`
 * and `ios-e2e.mjs` use, so all three device lanes emit one summary shape
 * (PR #14509 reconciliation). Every step's exit is loud: a non-zero child fails
 * the lane non-zero and the partial bundle is still finalized. The bundle's
 * absolute path is the final stdout line so an agent can post the smoke/
 * filmstrip + logs/ boot-trace inline to the PR.
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
  captureFailureForensics,
  collectBundleArtifacts,
  createDeviceE2eBundle,
  finalizeDeviceE2eBundle,
  formatFailureForensicsBlock,
  runBundledCommand,
  setBundleBuild,
  setBundleDevice,
} from "./lib/device-e2e-bundle.mjs";
import {
  buildDeviceDeployCommand,
  buildDeviceFailureBootTraceCommand,
  buildDeviceFailureScreenshotCommand,
  buildDeviceLogsCommand,
  buildDeviceSmokeCommand,
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

let activeDeviceContext = null;

function isNonEmptyFile(filePath) {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch {
    // error-policy:J3 Failure artifacts are optional diagnostics; absence is
    // recorded in the command log rather than treated as a captured file.
    return false;
  }
}

function directFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name));
}

function writeFailureCommandLog({ failureDir, label, command, result }) {
  const logPath = path.join(failureDir, `${label}.log`);
  const status =
    result.status === null
      ? `signal ${result.signal}`
      : `exit ${result.status}`;
  fs.writeFileSync(
    logPath,
    [
      `$ ${command.cmd} ${command.args.join(" ")}`,
      `status: ${status}`,
      "",
      "stdout:",
      result.stdout || "",
      "",
      "stderr:",
      result.stderr || "",
      "",
      "error:",
      result.error?.message || "",
    ].join("\n"),
  );
  return logPath;
}

function captureFailureCommand({ failureDir, label, command, expectedFiles }) {
  const before = new Set(directFiles(failureDir));
  const expected = new Set(expectedFiles);
  const result = spawnSync(command.cmd, command.args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const captured = expectedFiles.filter(isNonEmptyFile);
  const after = directFiles(failureDir).filter((file) => !before.has(file));
  const diagnosticLog = writeFailureCommandLog({
    failureDir,
    label,
    command,
    result,
  });
  const commandProducedUnexpectedFiles = after.filter(
    (file) =>
      file !== diagnosticLog && !expected.has(file) && isNonEmptyFile(file),
  );
  return [...captured, ...commandProducedUnexpectedFiles, diagnosticLog];
}

// Failure forensics for a chained-child step: the child script already wrote its
// own artifacts into smoke/ or logs/ when it reached those phases, and this adds
// point-of-failure evidence from the physical phone when the host tools allow it.
function captureDeviceFailure(bundle, step, error) {
  return captureFailureForensics(
    bundle,
    step,
    ({ failureDir }) => {
      const causePath = path.join(failureDir, "failure-cause.txt");
      fs.writeFileSync(causePath, `${error?.message ?? error}\n`);
      const artifacts = [causePath];
      if (!activeDeviceContext) return artifacts;

      const screenshotPath = path.join(failureDir, "screen.png");
      artifacts.push(
        ...captureFailureCommand({
          failureDir,
          label: "screenshot-capture",
          command: buildDeviceFailureScreenshotCommand({
            deviceUdid: activeDeviceContext.udid,
            outputFile: screenshotPath,
          }),
          expectedFiles: [screenshotPath],
        }),
      );

      artifacts.push(
        ...captureFailureCommand({
          failureDir,
          label: "boot-trace-capture",
          command: buildDeviceFailureBootTraceCommand({
            scriptsDir,
            deviceId: activeDeviceContext.deviceId,
            outputFile: path.join(failureDir, "boot-trace-run"),
            bundleId: activeDeviceContext.bundleId,
          }),
          expectedFiles: [],
        }),
      );
      return artifacts;
    },
    error,
  );
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
  activeDeviceContext = {
    bundleId,
    deviceId,
    identifier: device.identifier,
    udid: device.udid,
  };

  const bundle = createDeviceE2eBundle({
    appDir: appRoot,
    lane: "ios-device",
    outputDir: args.output,
  });
  setBundleDevice(bundle, {
    udid: device.udid,
    identifier: device.identifier,
    name: device.name,
    kind: "ios-device",
  });
  // skippedAppexes is run configuration that scopes what the build proves; carry
  // it on the build metadata (buildId/commit are filled in after the deploy).
  setBundleBuild(bundle, { skippedAppexes: skipAppexes });

  // BootCapture attachments land in smoke/ (per-#14337 bundle layout); the shared
  // finalize collects logs/ + raw/ + reports/, so smoke/ is collected explicitly.
  const smokeDir = path.join(bundle.root, "smoke");
  fs.mkdirSync(smokeDir, { recursive: true });

  const steps = planIosDeviceE2eSteps({
    skipLogs: Boolean(args["skip-logs"]),
  });
  log(`plan: ${steps.map((s) => s.id).join(" → ")}`);
  log(`bundle: ${bundle.root}`);

  const commandFor = (step) => {
    switch (step.id) {
      case "deploy":
        return buildDeviceDeployCommand({
          scriptsDir,
          deviceId,
          skipAppexes,
          bundleId,
        });
      case "smoke":
        return buildDeviceSmokeCommand({
          scriptsDir,
          deviceId,
          outputDir: smokeDir,
          requireChat: Boolean(args["require-chat"]),
          bundleId,
        });
      case "logs":
        return buildDeviceLogsCommand({
          scriptsDir,
          deviceId,
          // ios-device-logs derives its own trace filename from
          // path.dirname(--output), so point --output at a file inside logsDir.
          outputFile: path.join(bundle.logsDir, "boot-trace-run"),
          bundleId,
        });
      default:
        throw new Error(`unknown step: ${step.id}`);
    }
  };

  let finalResult = "failed";
  let finalError = null;
  try {
    for (const step of steps) {
      const { cmd, args: cmdArgs } = commandFor(step);
      runBundledCommand(bundle, step.label, cmd, cmdArgs, {
        cwd: appRoot,
        onFailure: (bundleStep, error) =>
          captureDeviceFailure(bundle, bundleStep, error),
      });
      if (step.id === "deploy") {
        // The deploy step installs the freshly built bundle; surface its
        // buildId/commit into the summary by reading the fresh dist stamp (the
        // exact bundle the deploy installed). The deploy already asserted
        // renderer freshness, so this is informational metadata only.
        try {
          const fresh = readRendererManifest(
            freshRendererManifestPath({ repoRoot }),
            "freshly built",
          );
          setBundleBuild(bundle, {
            buildId: fresh.buildId,
            commit: fresh.commit,
          });
        } catch (error) {
          // error-policy:J7 diagnostics-must-not-kill-the-loop — the summary's
          // build metadata is informational; the deploy already asserted
          // freshness. Warn and leave it null rather than failing a good run.
          bundle.warnings.push(
            `summary build metadata unavailable: ${error?.message ?? error}`,
          );
          log(`summary build metadata unavailable: ${error?.message ?? error}`);
        }
      }
    }
    finalResult = "passed";
  } catch (error) {
    // runBundledCommand already recorded the step as failed and ran the failure
    // forensics; this stops the chain at the first failing step.
    finalError = error;
  }

  collectBundleArtifacts(bundle, [smokeDir]);
  const bundleRoot = finalizeDeviceE2eBundle(bundle, finalResult);

  if (finalError) {
    log(
      `FAILED: ${finalError.message ?? finalError}. Bundle (partial) written.`,
    );
    const block = formatFailureForensicsBlock(bundle, finalError);
    if (block) process.stderr.write(`\n${block}`);
    // Last line: the absolute bundle path — the machine-readable handoff even on
    // failure (contract with #14337).
    console.log(bundleRoot);
    process.exit(1);
  }

  log(
    `ALL iOS DEVICE E2E PASSED ✅ (${skipAppexes ? "appexes SKIPPED — widget/keyboard/device-activity surfaces UNTESTED" : "appexes included"})`,
  );
  // Last line: the absolute bundle path (contract with #14337 — agents post the
  // smoke/ filmstrip + logs/ boot-trace inline to the PR).
  console.log(bundleRoot);
}

main().catch((error) => fail(error?.stack ?? String(error)));
