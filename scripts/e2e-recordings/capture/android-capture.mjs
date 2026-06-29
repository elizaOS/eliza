#!/usr/bin/env node
// Android device/emulator evidence capture (issue #9944).
//
// Reuses the harness adb/SDK resolution from
// packages/app/scripts/lib/android-device.mjs (so SDK discovery lives in one
// place) and the `adb shell screenrecord → /sdcard → adb pull` pattern from
// packages/app/test/android/onboarding-to-home.android.spec.ts.
//
// Produces three real artifacts for the connected device:
//   <evidence>/android/screen.png   adb exec-out screencap -p
//   <evidence>/android/screen.mp4   adb shell screenrecord (pulled)
//   <evidence>/android/logcat.log   adb logcat -d tail
// Skips with a reason (clean exit) when adb is missing or no device is in the
// `device` state.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_ISSUE,
  DEFAULT_SECONDS,
  DEFAULT_SLUG,
  evidenceDir,
  isMain,
  makeLogger,
  parseArgs,
  reportAndExit,
  skipped,
  sleep,
} from "./common.mjs";

const CLASS = "AndroidCapture";
const REMOTE_MP4 = "/sdcard/eliza-9944-capture.mp4";

async function loadAdbLib() {
  try {
    return await import("../../../packages/app/scripts/lib/android-device.mjs");
  } catch {
    return null;
  }
}

/**
 * Capture a screenshot, a short screen recording, and a logcat tail from a
 * connected Android device/emulator.
 *
 * @returns {Promise<{className:string, skipped:boolean, reason?:string,
 *   artifacts:{screenshot?:string, video?:string, log?:string}, error?:string}>}
 */
export async function captureAndroid(options = {}) {
  const log = makeLogger(CLASS);
  const issue = options.issue ?? DEFAULT_ISSUE;
  const slug = options.slug ?? DEFAULT_SLUG;
  const seconds = Number(options.seconds ?? DEFAULT_SECONDS);

  const lib = await loadAdbLib();
  if (!lib) {
    return skipped(CLASS, "android-device helper not importable");
  }

  let adb;
  try {
    adb = lib.resolveAdb();
  } catch (error) {
    return skipped(CLASS, `adb not found (${error.message.split("\n")[0]})`);
  }

  const devices = lib.listDevices(adb);
  if (devices.length === 0) {
    return skipped(CLASS, "no Android device/emulator in `device` state");
  }
  const serial =
    options.serial ??
    process.env.ANDROID_SERIAL ??
    devices.find((s) => s.startsWith("emulator-")) ??
    devices[0];
  log(`using device ${serial} (attached: ${devices.join(", ")})`);

  const outDir = evidenceDir({
    issue,
    slug,
    platform: "android",
    out: options.out,
  });

  const screenshotPath = path.join(outDir, "screen.png");
  const videoPath = path.join(outDir, "screen.mp4");
  const logPath = path.join(outDir, "logcat.log");

  // ── Screenshot ─────────────────────────────────────────────────────────
  log("capturing screenshot via exec-out screencap");
  const shot = spawnSync(adb, ["-s", serial, "exec-out", "screencap", "-p"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (shot.status !== 0 || !shot.stdout || shot.stdout.length === 0) {
    return {
      className: CLASS,
      skipped: false,
      artifacts: {},
      error: `screencap failed (status ${shot.status})`,
    };
  }
  fs.writeFileSync(screenshotPath, shot.stdout);
  log(`screenshot → ${screenshotPath} (${shot.stdout.length} bytes)`);

  // ── Screen recording ───────────────────────────────────────────────────
  // screenrecord only writes the trailing moov atom when it terminates of its
  // own accord, so we set --time-limit to the desired duration and wait for the
  // on-device process to exit (rather than killing it, which yields a truncated
  // "moov atom not found" mp4).
  spawnSync(adb, ["-s", serial, "shell", "rm", "-f", REMOTE_MP4], {
    stdio: "ignore",
  });
  const limit = Math.max(Math.round(seconds), 3);
  log(`recording screen for ${limit}s`);
  const recorder = spawn(
    adb,
    [
      "-s",
      serial,
      "shell",
      "screenrecord",
      "--bit-rate",
      "4000000",
      "--time-limit",
      String(limit),
      REMOTE_MP4,
    ],
    { stdio: "ignore" },
  );
  await sleep(750);

  // Drive a little harmless motion so the recording isn't a static frame.
  driveMotion(adb, serial, log);

  // Wait out the time-limit, then poll until screenrecord has fully exited and
  // flushed the moov atom on-device before pulling.
  await sleep(limit * 1000);
  for (let i = 0; i < 12; i++) {
    const pid = spawnSync(
      adb,
      ["-s", serial, "shell", "pidof", "screenrecord"],
      { encoding: "utf8" },
    ).stdout?.trim();
    if (!pid) break;
    await sleep(500);
  }
  await sleep(500);
  recorder.kill("SIGTERM");
  spawnSync(adb, ["-s", serial, "pull", REMOTE_MP4, videoPath], {
    stdio: "ignore",
  });
  spawnSync(adb, ["-s", serial, "shell", "rm", "-f", REMOTE_MP4], {
    stdio: "ignore",
  });
  const videoOk = fs.existsSync(videoPath) && fs.statSync(videoPath).size > 0;
  if (videoOk) {
    log(`recording → ${videoPath} (${fs.statSync(videoPath).size} bytes)`);
  } else {
    log("recording produced no file (continuing)");
  }

  // ── Logcat tail ────────────────────────────────────────────────────────
  log("capturing logcat tail");
  const logcat = spawnSync(
    adb,
    ["-s", serial, "logcat", "-d", "-v", "time", "-t", "2000"],
    { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
  );
  fs.writeFileSync(
    logPath,
    `# adb logcat -d (tail) — device ${serial} — ${new Date().toISOString()}\n` +
      (logcat.stdout ?? ""),
  );
  log(`logcat → ${logPath} (${fs.statSync(logPath).size} bytes)`);

  return {
    className: CLASS,
    skipped: false,
    artifacts: {
      screenshot: screenshotPath,
      video: videoOk ? videoPath : undefined,
      log: logPath,
    },
  };
}

function driveMotion(adb, serial, log) {
  const send = (args) =>
    spawnSync(adb, ["-s", serial, "shell", "input", ...args], {
      stdio: "ignore",
    });
  try {
    send(["keyevent", "KEYCODE_WAKEUP"]);
    send(["swipe", "540", "1600", "540", "600", "300"]);
    send(["swipe", "540", "600", "540", "1600", "300"]);
    log("drove wake + swipe gestures for recording motion");
  } catch {
    log("input gestures unavailable (continuing)");
  }
}

if (isMain(import.meta.url)) {
  const flags = parseArgs(process.argv.slice(2));
  captureAndroid(flags)
    .then(reportAndExit)
    .catch((error) => {
      console.error(`[${CLASS}] fatal: ${error.stack || error}`);
      process.exit(1);
    });
}
