/**
 * Pure step-sequencing and command-argument construction for the one-command
 * physical-iPhone e2e lane (`ios-device-e2e.mjs`, issue #14337), plus the
 * run-scoped triage-bundle summary shape.
 *
 * The lane chains three already-proven scripts — deploy → on-device BootCapture
 * assertion → boot-trace logs — into one command. This module owns the
 * deterministic decisions (which steps run, exactly which argv each gets, how a
 * step's exit becomes a verdict, what the summary.json looks like); the script
 * owns the impure edges (spawning node, reading files, writing the bundle).
 * Keeping the argv construction here means the exact flags the lane hands each
 * child are unit-tested against fixtures without a device.
 *
 * The on-device assertion is BootCapture, NOT `mobile-local-chat-smoke`: that
 * smoke targets the iOS Simulator, so on a physical iPhone the XCUITest
 * BootCapture harness ("did the freshly deployed app boot to home or an error
 * card") is the on-device assertion of record (issue #14337, research doc 08 §4).
 * BootCapture writes its filmstrip attachments into the smoke step's output dir,
 * so that one on-device boot yields both the pass/fail verdict and the watchable
 * filmstrip — there is no separate capture boot (a second identical BootCapture
 * run would only re-boot the phone to produce bytes the smoke step already has).
 *
 * Bundle shape mirrors research doc 08 Q2/Q3: a gitignored run-scoped dir with
 * `smoke/` (the BootCapture MP4/JPG the assertion produced), `logs/`, and a
 * JSON-canonical `summary.json` carrying lane, device identity, installed
 * buildId/commit, and per-step status/duration/artifact paths. The device-e2e
 * bundle library (`lib/device-e2e-bundle.mjs`) is owned by a sibling PR
 * (#14336); this lane ships a minimal local emitter matching that documented
 * shape and is reconciled onto the shared lib when it lands.
 */
import path from "node:path";

/** Canonical step ids, in execution order. */
export const IOS_DEVICE_E2E_STEP_IDS = Object.freeze([
  "deploy",
  "smoke",
  "logs",
]);

/**
 * Plan the ordered steps for a physical-iPhone e2e run. Deploy + smoke are
 * mandatory — this lane has no "vacuous" mode: a run that skipped the on-device
 * assertion would print success without proving the phone booted the new build.
 * The smoke step's BootCapture run already emits the watchable filmstrip, so
 * there is no separate capture step. `--skip-logs` exists only to trim the
 * (non-assertion) boot-trace pull for tight iteration.
 *
 * @param {{ skipLogs?: boolean }} [flags]
 * @returns {Array<{ id: string, label: string }>}
 */
export function planIosDeviceE2eSteps({ skipLogs = false } = {}) {
  const steps = [
    {
      id: "deploy",
      label: "deploy signed App.app to the device (--skip-appexes)",
    },
    {
      id: "smoke",
      label:
        "on-device BootCapture assertion + filmstrip (boots to home or error card)",
    },
  ];
  if (!skipLogs) {
    steps.push({
      id: "logs",
      label: "pull the full-Bun boot-trace (--no-console)",
    });
  }
  return steps;
}

/**
 * Absolute node argv for the deploy step. `--skip-appexes` is the default
 * unattended posture (PR #13174, research doc Q6): per-appex profiles need an
 * ASC API key, so widget/keyboard/device-activity surfaces are stripped and the
 * deploy logs that loudly. `--device` is always passed through so the whole lane
 * pins one phone.
 *
 * @param {{ scriptsDir: string, deviceId: string, skipAppexes?: boolean,
 *           skipBuild?: boolean, noLaunch?: boolean, bundleId?: string | null }} opts
 * @returns {{ cmd: string, args: string[] }}
 */
export function buildDeviceDeployCommand({
  scriptsDir,
  deviceId,
  skipAppexes = true,
  skipBuild = false,
  noLaunch = false,
  bundleId = null,
}) {
  if (!deviceId)
    throw new Error("buildDeviceDeployCommand: deviceId is required");
  const args = [
    path.join(scriptsDir, "ios-device-deploy.mjs"),
    "--device",
    deviceId,
  ];
  if (skipAppexes) args.push("--skip-appexes");
  if (skipBuild) args.push("--skip-build");
  if (noLaunch) args.push("--no-launch");
  if (bundleId) args.push("--bundle-id", bundleId);
  return { cmd: "node", args };
}

/**
 * Absolute node argv for the on-device BootCapture assertion. `--skip-build`
 * is forced: deploy already built + installed the current tree, so the capture
 * must reuse that install, never rebuild a second bundle. `--output` targets the
 * run bundle's `smoke/` subdir so the assertion's attachments land inside the
 * triage bundle.
 *
 * @param {{ scriptsDir: string, deviceId: string, outputDir: string,
 *           requireChat?: boolean, bundleId?: string | null }} opts
 * @returns {{ cmd: string, args: string[] }}
 */
export function buildDeviceSmokeCommand({
  scriptsDir,
  deviceId,
  outputDir,
  requireChat = false,
  bundleId = null,
}) {
  if (!deviceId)
    throw new Error("buildDeviceSmokeCommand: deviceId is required");
  if (!outputDir)
    throw new Error("buildDeviceSmokeCommand: outputDir is required");
  const args = [
    path.join(scriptsDir, "ios-device-capture.mjs"),
    "--platform",
    "device",
    "--device",
    deviceId,
    "--skip-build",
    "--output",
    outputDir,
  ];
  if (requireChat) args.push("--require-chat");
  if (bundleId) args.push("--bundle-id", bundleId);
  return { cmd: "node", args };
}

/**
 * Absolute node argv for the boot-trace logs step. `--no-console
 * --pull-boot-trace` is the ONLY engine-observability path on the full-Bun
 * build: an attached `--console` launch SIGTRAPs the no-JIT engine host at load
 * (#11515). `--output` writes the pulled trace into the bundle's `logs/` dir.
 *
 * @param {{ scriptsDir: string, deviceId: string, outputFile: string,
 *           bundleId?: string | null }} opts
 * @returns {{ cmd: string, args: string[] }}
 */
export function buildDeviceLogsCommand({
  scriptsDir,
  deviceId,
  outputFile,
  bundleId = null,
}) {
  if (!deviceId)
    throw new Error("buildDeviceLogsCommand: deviceId is required");
  if (!outputFile)
    throw new Error("buildDeviceLogsCommand: outputFile is required");
  const args = [
    path.join(scriptsDir, "ios-device-logs.mjs"),
    "--device",
    deviceId,
    "--no-console",
    "--pull-boot-trace",
    "--output",
    outputFile,
  ];
  if (bundleId) args.push("--bundle-id", bundleId);
  return { cmd: "node", args };
}

/**
 * Classify a step's process exit into a bundle verdict. A null status is a
 * spawn that never produced an exit code (the child could not be launched) —
 * treated as failure, never as success. Only exit 0 passes.
 *
 * @param {number | null} status
 * @returns {{ status: 'passed' | 'failed', ok: boolean }}
 */
export function classifyStepStatus(status) {
  const ok = status === 0;
  return { status: ok ? "passed" : "failed", ok };
}

export const IOS_DEVICE_E2E_SUMMARY_SCHEMA = "elizaos.device-e2e.summary/v1";

/**
 * Assemble the run-scoped `summary.json` (JSON-canonical machine-readable
 * artifact, research doc Q3). `steps` are the recorded per-step results;
 * `overallStatus` is `passed` iff every executed step passed. The `bundleDir`
 * is echoed so a consumer that only has the summary can locate the artifacts.
 *
 * @param {{
 *   runId: string,
 *   startedAt: string,
 *   finishedAt: string,
 *   bundleDir: string,
 *   device: { udid: string | null, identifier: string | null, name: string | null },
 *   build: { buildId: string | null, commit: string | null },
 *   skippedAppexes: boolean,
 *   steps: Array<{ id: string, label: string, status: 'passed' | 'failed',
 *                  durationMs: number, artifacts: string[] }>,
 * }} input
 * @returns {Record<string, unknown>}
 */
export function buildRunSummary(input) {
  if (!input?.runId) throw new Error("buildRunSummary: runId is required");
  const steps = input.steps ?? [];
  const overallStatus = steps.every((step) => step.status === "passed")
    ? "passed"
    : "failed";
  return {
    schema: IOS_DEVICE_E2E_SUMMARY_SCHEMA,
    lane: "ios-device-e2e",
    runId: input.runId,
    overallStatus,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    bundleDir: input.bundleDir,
    device: {
      udid: input.device?.udid ?? null,
      identifier: input.device?.identifier ?? null,
      name: input.device?.name ?? null,
    },
    build: {
      buildId: input.build?.buildId ?? null,
      commit: input.build?.commit ?? null,
    },
    skippedAppexes: input.skippedAppexes === true,
    steps: steps.map((step) => ({
      id: step.id,
      label: step.label,
      status: step.status,
      durationMs: step.durationMs,
      artifacts: step.artifacts ?? [],
    })),
  };
}

/**
 * A run id from a Date: `YYYYMMDD-HHMMSS` in UTC. Stable, sortable, filesystem
 * safe — used as the run-scoped bundle directory suffix.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function formatRunId(now = new Date()) {
  const iso = now.toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso
    .slice(11, 19)
    .replaceAll(":", "")}`;
}
