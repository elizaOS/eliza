#!/usr/bin/env node
/**
 * Captures iOS Simulator e2e evidence: boots a simulator, builds and installs
 * the app (unless --skip-build), drives it against a host agent, and collects a
 * screenshot plus video into the issue-evidence dir. Exits with SKIP_EXIT_CODE
 * (77) when no simulator is available. Shares arg parsing and manifest writing
 * with the other native capture scripts via native-capture-common.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import {
  captureIosSimulatorScreenshot,
  ensureBootedIosSimulator,
  iosSimulatorAvailabilityReason,
  startIosSimulatorVideo,
} from "../../packages/app/scripts/lib/ios-simulator-capture.mjs";
import {
  argValue,
  copyArtifact,
  createCaptureLog,
  hasArg,
  resolveCapturePaths,
  runCommandWithLog,
  SKIP_EXIT_CODE,
  startDeviceE2EHostAgent,
  writeCaptureManifest,
} from "./native-capture-common.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const APP_DIR = path.join(REPO_ROOT, "packages", "app");
const args = process.argv.slice(2);

async function maybeBuildIosSimulatorApp(logSink) {
  if (
    hasArg(args, "--skip-build") ||
    process.env.IOS_CAPTURE_SKIP_BUILD === "1"
  ) {
    logSink.log("skipping iOS simulator build");
    return;
  }
  await runCommandWithLog(
    "bun",
    ["run", "--cwd", "packages/app", "build:ios:local:sim"],
    {
      cwd: REPO_ROOT,
      logSink,
      label: "bun run --cwd packages/app build:ios:local:sim",
    },
  );
}

async function main() {
  const deviceName = argValue(args, "--device", process.env.IOS_SIMULATOR_NAME);
  const reason = iosSimulatorAvailabilityReason({ deviceName });
  if (hasArg(args, "--check")) {
    if (reason) {
      console.log(reason);
      process.exit(SKIP_EXIT_CODE);
    }
    console.log("iOS simulator capture prerequisites are available.");
    return;
  }
  if (reason) {
    console.log(reason);
    process.exit(SKIP_EXIT_CODE);
  }

  const { prefix, evidenceDir, recordingResultDir } = resolveCapturePaths({
    repoRoot: REPO_ROOT,
    platform: "ios-sim",
    slug: "ios-sim-capture",
    args,
  });
  fs.rmSync(recordingResultDir, { recursive: true, force: true });
  fs.mkdirSync(recordingResultDir, { recursive: true });

  const logSink = createCaptureLog(
    path.join(evidenceDir, `${prefix}-capture.log`),
    "ios-sim-capture",
  );
  const sourceDir = path.join(
    APP_DIR,
    "test-results",
    "ios-onboarding-to-home",
  );
  let hostAgent = null;
  let recording = null;
  let udid = null;
  try {
    udid = ensureBootedIosSimulator({ deviceName, log: logSink.log });
    await maybeBuildIosSimulatorApp(logSink);
    hostAgent = await startDeviceE2EHostAgent({
      repoRoot: REPO_ROOT,
      logSink,
    });

    recording = startIosSimulatorVideo({
      target: "booted",
      artifactDir: evidenceDir,
      filename: `${prefix}-onboarding-to-home.mov`,
      log: logSink.log,
    });

    await runCommandWithLog(
      process.execPath,
      [
        "packages/app/scripts/ios-onboarding-smoke.mjs",
        "--no-video",
        "--api-base",
        "http://127.0.0.1:31337",
      ],
      {
        cwd: REPO_ROOT,
        logSink,
        label:
          "node packages/app/scripts/ios-onboarding-smoke.mjs --no-video --api-base http://127.0.0.1:31337",
      },
    );

    const video = await recording.stop();
    recording = null;
    if (!video) throw new Error("iOS simulator recording was not written.");

    const finalScreenshot = captureIosSimulatorScreenshot({
      target: "booted",
      artifactDir: evidenceDir,
      filename: `${prefix}-home-landing.png`,
      log: logSink.log,
    });

    const freshScreenshot = copyArtifact(
      path.join(sourceDir, "fresh-onboarding.png"),
      evidenceDir,
      `${prefix}-fresh-onboarding.png`,
    );
    const smokeHomeScreenshot = copyArtifact(
      path.join(sourceDir, "home-landing.png"),
      evidenceDir,
      `${prefix}-smoke-home-landing.png`,
    );
    const resultJson = copyArtifact(
      path.join(sourceDir, "result.json"),
      evidenceDir,
      `${prefix}-result.json`,
      { required: false },
    );

    copyArtifact(freshScreenshot, recordingResultDir, "fresh-onboarding.png");
    copyArtifact(
      smokeHomeScreenshot,
      recordingResultDir,
      "smoke-home-landing.png",
    );
    copyArtifact(finalScreenshot, recordingResultDir, "home-landing.png");
    copyArtifact(video, recordingResultDir, "onboarding-to-home.mov");
    copyArtifact(resultJson, recordingResultDir, "result.json", {
      required: false,
    });
    copyArtifact(logSink.logPath, recordingResultDir, "capture.log", {
      required: false,
    });
    const manifest = {
      platform: "ios-sim",
      udid,
      evidenceDir,
      artifacts: {
        freshScreenshot,
        smokeHomeScreenshot,
        finalScreenshot,
        walkthrough: video,
        resultJson,
        captureLog: logSink.logPath,
      },
    };
    writeCaptureManifest(
      path.join(recordingResultDir, "manifest.json"),
      manifest,
    );
    writeCaptureManifest(path.join(evidenceDir, "manifest.json"), manifest);
    logSink.log(`capture artifacts written to ${evidenceDir}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logSink.log(`FAILED: ${errorMessage}`);
    const video = recording ? await recording.stop() : null;
    recording = null;
    let failureDeviceScreenshot = null;
    try {
      failureDeviceScreenshot = captureIosSimulatorScreenshot({
        target: "booted",
        artifactDir: evidenceDir,
        filename: `${prefix}-failure-final.png`,
        log: logSink.log,
      });
    } catch (screenshotError) {
      logSink.log(
        `failed to capture final failure screenshot: ${
          screenshotError instanceof Error
            ? screenshotError.message
            : String(screenshotError)
        }`,
      );
    }
    const freshScreenshot = copyArtifact(
      path.join(sourceDir, "fresh-onboarding.png"),
      evidenceDir,
      `${prefix}-fresh-onboarding.png`,
      { required: false },
    );
    const smokeFailureScreenshot = copyArtifact(
      path.join(sourceDir, "failure.png"),
      evidenceDir,
      `${prefix}-smoke-failure.png`,
      { required: false },
    );
    const resultJson = copyArtifact(
      path.join(sourceDir, "result.json"),
      evidenceDir,
      `${prefix}-result.json`,
      { required: false },
    );
    copyArtifact(freshScreenshot, recordingResultDir, "fresh-onboarding.png", {
      required: false,
    });
    copyArtifact(
      smokeFailureScreenshot,
      recordingResultDir,
      "smoke-failure.png",
      { required: false },
    );
    copyArtifact(
      failureDeviceScreenshot,
      recordingResultDir,
      "failure-final.png",
      { required: false },
    );
    copyArtifact(video, recordingResultDir, "onboarding-to-home.mov", {
      required: false,
    });
    copyArtifact(resultJson, recordingResultDir, "result.json", {
      required: false,
    });
    copyArtifact(logSink.logPath, recordingResultDir, "capture.log", {
      required: false,
    });
    const manifest = {
      platform: "ios-sim",
      status: "failed",
      error: errorMessage,
      udid,
      evidenceDir,
      artifacts: {
        freshScreenshot,
        smokeFailureScreenshot,
        failureDeviceScreenshot,
        walkthrough: video,
        resultJson,
        captureLog: logSink.logPath,
      },
    };
    writeCaptureManifest(
      path.join(recordingResultDir, "manifest.json"),
      manifest,
    );
    writeCaptureManifest(path.join(evidenceDir, "manifest.json"), manifest);
    throw error;
  } finally {
    if (recording) await recording.stop();
    await hostAgent?.stop();
    logSink?.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
