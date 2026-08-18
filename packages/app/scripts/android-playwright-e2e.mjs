#!/usr/bin/env node
/**
 * Bundle-preserving entrypoint for focused Android Playwright device lanes.
 *
 * The full Android orchestrator already owns its evidence bundle, but the
 * focused CI shell scripts also invoke individual Playwright specs. Keeping
 * those calls behind this entrypoint guarantees that SDK/device setup failures
 * and Playwright failures still finish one self-contained device-e2e bundle.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureAndroidLogcat,
  captureAndroidScreenshot,
  startAndroidScreenRecord,
} from "./lib/android-capture.mjs";
import {
  readInstalledRendererStamp,
  resolveAdb,
  resolveSerial,
} from "./lib/android-device.mjs";
import {
  assertExactBundleCommit,
  captureFailureForensics,
  createDeviceE2eBundle,
  finalizeDeviceE2eBundle,
  finishBundleStep,
  formatFailureForensicsBlock,
  getDeviceE2eBundleFinalizationError,
  recordBundleArtifact,
  recordBundleRunnerFailure,
  runBundledCommand,
  setBundleBuild,
  setBundleDevice,
  startBundleStep,
} from "./lib/device-e2e-bundle.mjs";
import { acquireDeviceLease } from "./lib/device-lease.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const appDir = path.resolve(scriptPath, "..", "..");
const log = (message) => console.log(`[android-playwright-e2e] ${message}`);

function readOption(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseAndroidPlaywrightE2eArgs(argv) {
  const parsed = {
    output: undefined,
    serial: undefined,
    noWait: false,
    playwrightArgs: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--output") {
      parsed.output = readOption(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--serial") {
      parsed.serial = readOption(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--no-wait") {
      parsed.noWait = true;
      continue;
    }
    parsed.playwrightArgs.push(arg);
  }
  return parsed;
}

function captureAndroidFailure(bundle, step, { adb, serial, error }) {
  return captureFailureForensics(
    bundle,
    step,
    ({ failureDir }) => {
      const files = [];
      const causePath = path.join(failureDir, "failure-cause.txt");
      fs.writeFileSync(causePath, `${error?.message ?? error}\n`);
      files.push(causePath);
      if (adb && serial) {
        files.push(
          captureAndroidScreenshot({
            adb,
            serial,
            artifactDir: failureDir,
            filename: "screen.png",
            log,
          }),
        );
        files.push(
          captureAndroidLogcat({
            adb,
            serial,
            artifactDir: failureDir,
            filename: "logcat.txt",
            lines: 2_000,
            log,
          }),
        );
      }
      return files;
    },
    error,
  );
}

function finishFailedStep(bundle, step, context) {
  captureAndroidFailure(bundle, step, context);
  finishBundleStep(bundle, step, "failed", context.error);
}

export function verifyInstalledAndroidBuild(bundle, installedStamp) {
  setBundleBuild(bundle, {
    buildId: installedStamp?.buildId ?? null,
    commit: installedStamp?.commit ?? null,
  });
  assertExactBundleCommit(
    installedStamp?.commit,
    bundle.expectedCommit,
    "installed Android build",
  );
  return bundle.build;
}

export async function runAndroidPlaywrightE2e(argv = process.argv.slice(2)) {
  const flags = parseAndroidPlaywrightE2eArgs(argv);
  if (flags.playwrightArgs.length === 0) {
    throw new Error("at least one Android Playwright test or flag is required");
  }
  const bundle = createDeviceE2eBundle({
    appDir,
    lane: "android-playwright",
    outputDir: flags.output,
  });
  let adb = null;
  let serial = null;
  let lease = null;
  let finalResult = "failed";
  let finalError = null;
  let finalizationError = null;
  let flowRecording = null;

  try {
    const setupStep = startBundleStep(bundle, "resolve Android device");
    try {
      adb = resolveAdb();
      serial = resolveSerial(adb, flags.serial ?? process.env.ANDROID_SERIAL);
      setBundleDevice(bundle, { serial, kind: "android" });
      finishBundleStep(bundle, setupStep, "passed");
    } catch (error) {
      finishFailedStep(bundle, setupStep, { adb, serial, error });
      throw error;
    }

    log(`device serial=${serial}`);
    lease = await acquireDeviceLease(`android:${serial}`, {
      waitMs: flags.noWait ? 0 : undefined,
      log,
    });

    const stampStep = startBundleStep(bundle, "verify installed Android build");
    try {
      const installedStamp = readInstalledRendererStamp(adb, serial, { log });
      verifyInstalledAndroidBuild(bundle, installedStamp);
      finishBundleStep(bundle, stampStep, "passed");
    } catch (error) {
      finishFailedStep(bundle, stampStep, { adb, serial, error });
      throw error;
    }

    flowRecording = await startAndroidScreenRecord({
      adb,
      serial,
      artifactDir: bundle.rawDir,
      filename: "android-tested-flow.mp4",
      remotePath: `/sdcard/eliza-android-playwright-flow-${process.pid}.mp4`,
      log,
    });
    runBundledCommand(
      bundle,
      "Android Playwright device tests",
      "node",
      [
        "scripts/run-ui-playwright.mjs",
        "--config",
        "playwright.android.config.ts",
        ...flags.playwrightArgs,
      ],
      {
        cwd: appDir,
        env: {
          ANDROID_SERIAL: serial,
          ELIZA_DEVICE_E2E_ARTIFACT_DIR: path.join(bundle.root, "test-results"),
          ELIZA_ANDROID_ARTIFACT_DIR: path.join(
            bundle.root,
            "test-results",
            "android",
          ),
          ELIZA_ANDROID_PARENT_RECORDING: "1",
          ELIZA_ANDROID_PLAYWRIGHT_OUTPUT_DIR: path.join(
            bundle.root,
            "test-results",
            "android-playwright",
          ),
          ELIZA_ANDROID_PLAYWRIGHT_JUNIT: path.join(
            bundle.reportsDir,
            "android-playwright.junit.xml",
          ),
          ELIZA_ANDROID_PLAYWRIGHT_JSON: path.join(
            bundle.reportsDir,
            "android-playwright.json",
          ),
          PLAYWRIGHT_HTML_REPORT: path.join(
            bundle.reportsDir,
            "android-playwright-html",
          ),
        },
        onFailure: (step, error) =>
          captureAndroidFailure(bundle, step, { adb, serial, error }),
      },
    );
    const recording = flowRecording;
    flowRecording = null;
    const videoPath = await recording.stop();
    if (!videoPath) {
      throw new Error("Android tested-flow recording did not finalize");
    }
    recordBundleArtifact(bundle, videoPath, "video");
    finalResult = "passed";
  } catch (error) {
    finalError = error;
    recordBundleRunnerFailure(bundle, error);
  } finally {
    if (flowRecording) {
      const recording = flowRecording;
      flowRecording = null;
      try {
        const videoPath = await recording.stop();
        if (videoPath) recordBundleArtifact(bundle, videoPath, "video");
      } catch (error) {
        bundle.warnings.push(
          `Android tested-flow recording finalization failed: ${error?.message ?? error}`,
        );
      }
    }
    if (adb && serial) {
      try {
        const installedStamp = readInstalledRendererStamp(adb, serial, { log });
        setBundleBuild(bundle, {
          buildId: installedStamp?.buildId ?? null,
          commit: installedStamp?.commit ?? null,
        });
      } catch (error) {
        bundle.warnings.push(
          `installed Android build stamp failed: ${error?.message ?? error}`,
        );
      }
      try {
        recordBundleArtifact(
          bundle,
          captureAndroidScreenshot({
            adb,
            serial,
            artifactDir: bundle.rawDir,
            filename: "android-final.png",
            log,
          }),
          "screenshot",
        );
      } catch (error) {
        bundle.warnings.push(
          `final Android screenshot failed: ${error?.message ?? error}`,
        );
      }
      try {
        recordBundleArtifact(
          bundle,
          captureAndroidLogcat({
            adb,
            serial,
            artifactDir: bundle.logsDir,
            filename: "android-logcat.txt",
            lines: 2_000,
            log,
          }),
          "log",
        );
      } catch (error) {
        bundle.warnings.push(
          `Android logcat capture failed: ${error?.message ?? error}`,
        );
      }
    }
    try {
      lease?.release();
    } catch (error) {
      bundle.warnings.push(
        `Android device lease release failed: ${error?.message ?? error}`,
      );
    }
    const bundleRoot = finalizeDeviceE2eBundle(bundle, finalResult, {
      requiredEvidence: {
        buildId: true,
        commit: true,
        inlineScreenshot: true,
        inlineVideo: true,
        logs: true,
      },
    });
    finalizationError = getDeviceE2eBundleFinalizationError(bundle);
    if (finalError) {
      const block = formatFailureForensicsBlock(bundle, finalError);
      if (block) process.stderr.write(`\n${block}`);
    }
    log(`bundle: ${bundleRoot}`);
  }
  if (finalError) throw finalError;
  if (finalizationError) throw finalizationError;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runAndroidPlaywrightE2e().catch((error) => {
    console.error(
      `[android-playwright-e2e] FAILED: ${error?.message ?? error}`,
    );
    process.exit(1);
  });
}
