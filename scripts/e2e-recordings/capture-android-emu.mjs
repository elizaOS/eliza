#!/usr/bin/env node
/**
 * Captures Android emulator e2e evidence: boots (or reuses) an AVD, installs the
 * app APK, drives it against a host agent, and collects a screenshot plus logcat
 * into the issue-evidence dir. Exits with SKIP_EXIT_CODE (77) when no emulator
 * is available. Shares arg parsing and manifest writing with the other native
 * capture scripts via native-capture-common.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import {
  captureAndroidLogcat,
  captureAndroidScreenshot,
} from "../../packages/app/scripts/lib/android-capture.mjs";
import {
  ensureEmulatorBooted,
  ensureEmulatorPermissive,
  installApk,
  listAvds,
  listDevices,
  resolveAdb,
  resolveApk,
  resolveEmulator,
} from "../../packages/app/scripts/lib/android-device.mjs";
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

function androidAvailabilityReason() {
  let adb;
  try {
    adb = resolveAdb();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  const requestedSerial = argValue(
    args,
    "--serial",
    process.env.ANDROID_SERIAL,
  );
  if (requestedSerial && !requestedSerial.startsWith("emulator-")) {
    return `requested Android serial ${requestedSerial} is not an emulator`;
  }

  const devices = listDevices(adb);
  if (
    requestedSerial
      ? devices.includes(requestedSerial)
      : devices.some((serial) => serial.startsWith("emulator-"))
  ) {
    return null;
  }

  const emulator = resolveEmulator();
  if (!emulator) {
    return "No Android emulator is attached and the emulator binary was not found.";
  }
  const avds = listAvds(emulator);
  if (avds.length === 0) {
    return "No Android AVD is configured. Create one with Android Studio Device Manager.";
  }
  return null;
}

async function selectOrBootEmulator(adb, log) {
  const requestedSerial = argValue(
    args,
    "--serial",
    process.env.ANDROID_SERIAL,
  );
  if (requestedSerial) return requestedSerial;
  const existing = listDevices(adb).find((serial) =>
    serial.startsWith("emulator-"),
  );
  if (existing) {
    log(`reusing attached Android emulator ${existing}`);
    return existing;
  }
  return ensureEmulatorBooted({
    adb,
    avd: argValue(args, "--avd"),
    log,
  });
}

async function ensureDebugApk(logSink) {
  try {
    const apk = resolveApk(process.env.ELIZA_ANDROID_APK);
    logSink.log(`using debug APK ${apk}`);
    return apk;
  } catch (error) {
    if (
      hasArg(args, "--skip-build") ||
      process.env.ANDROID_CAPTURE_SKIP_BUILD === "1"
    ) {
      throw error;
    }
  }

  await runCommandWithLog(
    "bun",
    ["run", "--cwd", "packages/app", "build:android"],
    {
      cwd: REPO_ROOT,
      env: {
        ELIZA_MOBILE_REPO_ROOT: REPO_ROOT,
        ELIZA_WEBVIEW_DEBUG: "1",
        ELIZA_BUN_RISCV64_OPTIONAL: "1",
      },
      logSink,
      label: "bun run --cwd packages/app build:android",
    },
  );
  const apk = resolveApk(process.env.ELIZA_ANDROID_APK);
  logSink.log(`using debug APK ${apk}`);
  return apk;
}

async function main() {
  const reason = androidAvailabilityReason();
  if (hasArg(args, "--check")) {
    if (reason) {
      console.log(reason);
      process.exit(SKIP_EXIT_CODE);
    }
    console.log("Android emulator capture prerequisites are available.");
    return;
  }
  if (reason) {
    console.log(reason);
    process.exit(SKIP_EXIT_CODE);
  }

  const { prefix, evidenceDir, recordingResultDir } = resolveCapturePaths({
    repoRoot: REPO_ROOT,
    platform: "android-emu",
    slug: "android-emu-capture",
    args,
  });
  fs.rmSync(recordingResultDir, { recursive: true, force: true });
  fs.mkdirSync(recordingResultDir, { recursive: true });

  const logSink = createCaptureLog(
    path.join(evidenceDir, `${prefix}-capture.log`),
    "android-emu-capture",
  );
  let hostAgent = null;
  try {
    const adb = resolveAdb();
    const serial = await selectOrBootEmulator(adb, logSink.log);
    process.env.ANDROID_SERIAL = serial;
    await ensureEmulatorPermissive(adb, serial, { log: logSink.log });
    const apk = await ensureDebugApk(logSink);
    logSink.log(`installing debug APK on ${serial}: ${apk}`);
    installApk(adb, serial, apk);

    hostAgent = await startDeviceE2EHostAgent({
      repoRoot: REPO_ROOT,
      logSink,
    });

    await runCommandWithLog(
      "bun",
      ["run", "--cwd", "packages/app", "test:e2e:android:onboarding"],
      {
        cwd: REPO_ROOT,
        env: {
          ANDROID_SERIAL: serial,
          ELIZA_ANDROID_BACKEND: "host",
          ELIZA_ANDROID_REQUIRE_AGENT: "1",
        },
        logSink,
        label: "bun run --cwd packages/app test:e2e:android:onboarding",
      },
    );

    const sourceDir = path.join(
      APP_DIR,
      "test-results",
      "android-onboarding-to-home",
    );
    const homeScreenshot = copyArtifact(
      path.join(sourceDir, "home-landing.png"),
      evidenceDir,
      `${prefix}-home-landing.png`,
    );
    const walkthrough = copyArtifact(
      path.join(sourceDir, "onboarding-to-home.mp4"),
      evidenceDir,
      `${prefix}-onboarding-to-home.mp4`,
    );
    const deviceScreenshot = captureAndroidScreenshot({
      adb,
      serial,
      artifactDir: evidenceDir,
      filename: `${prefix}-device-final.png`,
      log: logSink.log,
    });
    const logcat = captureAndroidLogcat({
      adb,
      serial,
      artifactDir: evidenceDir,
      filename: `${prefix}-logcat.txt`,
      log: logSink.log,
    });

    copyArtifact(homeScreenshot, recordingResultDir, "home-landing.png");
    copyArtifact(deviceScreenshot, recordingResultDir, "device-final.png");
    copyArtifact(walkthrough, recordingResultDir, "onboarding-to-home.mp4");
    copyArtifact(logcat, recordingResultDir, "logcat.txt", {
      required: false,
    });
    copyArtifact(logSink.logPath, recordingResultDir, "capture.log", {
      required: false,
    });
    const manifest = {
      platform: "android-emu",
      serial,
      evidenceDir,
      artifacts: {
        homeScreenshot,
        deviceScreenshot,
        walkthrough,
        logcat,
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
    logSink.log(
      `FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  } finally {
    await hostAgent?.stop();
    logSink?.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
