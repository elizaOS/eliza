#!/usr/bin/env node
// Android emulator/device evidence capture (issue #9944): screenshot + screen
// recording + logcat tail from an attached device, written to
// `.github/issue-evidence/`. Skips with a reason (exit 0) when adb is missing or
// no device is in `device` state, so it is safe inside the e2e-recordings sweep
// on any host. Reuses the shared adb/serial resolution in lib/android-device.mjs.
//
// Flags:
//   --issue <n> --slug <s>   name artifacts `<n>-<s>-android-emu.{png,mp4,log}`
//   --serial <serial>        target a specific device (default: ANDROID_SERIAL → emulator → first)
//   --duration <seconds>     recording length (default 6, max 180 per screenrecord)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { resolveAdb, resolveSerial } from "./lib/android-device.mjs";
import {
  captureBackendLog,
  evidenceBaseName,
  evidencePath,
  logFor,
  mirrorToRecordings,
  parseFlags,
  skip,
} from "./lib/issue-evidence.mjs";

const PLATFORM = "android-emu";
const log = logFor(PLATFORM);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REMOTE_DIRS = ["/sdcard", "/data/local/tmp"];

function isNonEmptyFile(path) {
  return existsSync(path) && statSync(path).size > 0;
}

function removeRemote(adb, serial, remote) {
  spawnSync(adb, ["-s", serial, "shell", "rm", "-f", remote], {
    stdio: "ignore",
  });
}

function pullRemote(adb, serial, remote, outPath) {
  spawnSync(adb, ["-s", serial, "pull", remote, outPath], { stdio: "ignore" });
  return isNonEmptyFile(outPath);
}

function captureScreenshotViaRemote(adb, serial, outPath, remote) {
  removeRemote(adb, serial, remote);
  spawnSync(adb, ["-s", serial, "shell", "screencap", "-p", remote], {
    stdio: "ignore",
  });
  const pulled = pullRemote(adb, serial, remote, outPath);
  removeRemote(adb, serial, remote);
  return pulled;
}

function captureScreenshotViaExecOut(adb, serial, outPath) {
  const res = spawnSync(adb, ["-s", serial, "exec-out", "screencap", "-p"], {
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.status !== 0 || !res.stdout?.length) return false;
  writeFileSync(outPath, res.stdout);
  return isNonEmptyFile(outPath);
}

function captureScreenshot(adb, serial, outPath) {
  for (const dir of REMOTE_DIRS) {
    if (
      captureScreenshotViaRemote(
        adb,
        serial,
        outPath,
        `${dir}/eliza-evidence-capture.png`,
      )
    ) {
      return outPath;
    }
  }
  return captureScreenshotViaExecOut(adb, serial, outPath) ? outPath : null;
}

async function recordVideoToRemote(adb, serial, outPath, durationSec, remote) {
  removeRemote(adb, serial, remote);
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
      String(Math.min(180, Math.max(1, durationSec))),
      remote,
    ],
    { stdio: "ignore" },
  );
  await delay(750);
  await delay(Math.max(1, durationSec) * 1000);
  // screenrecord finalizes the mp4 on SIGINT.
  spawnSync(adb, ["-s", serial, "shell", "pkill", "-INT", "screenrecord"], {
    stdio: "ignore",
  });
  recorder.kill("SIGINT");
  await Promise.race([
    new Promise((resolve) => recorder.once("close", resolve)),
    delay(5_000),
  ]);
  const pulled = pullRemote(adb, serial, remote, outPath);
  removeRemote(adb, serial, remote);
  return pulled;
}

async function recordVideo(adb, serial, outPath, durationSec) {
  for (const dir of REMOTE_DIRS) {
    if (
      await recordVideoToRemote(
        adb,
        serial,
        outPath,
        durationSec,
        `${dir}/eliza-evidence-capture.mp4`,
      )
    ) {
      return outPath;
    }
  }
  return null;
}

function captureLogcat(adb, serial, outPath) {
  const res = spawnSync(adb, ["-s", serial, "logcat", "-d", "-t", "500"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0 || !res.stdout) return null;
  writeFileSync(outPath, res.stdout, "utf8");
  return outPath;
}

async function main() {
  const flags = parseFlags();

  let adb;
  try {
    adb = resolveAdb();
  } catch {
    skip(
      PLATFORM,
      "adb not found (install Android SDK platform-tools / set ANDROID_HOME)",
    );
  }

  let serial;
  try {
    serial = resolveSerial(adb, flags.serial);
  } catch {
    skip(PLATFORM, "no Android device/emulator in `device` state");
  }
  log(`capturing from device ${serial}`);

  const base = evidenceBaseName({
    issue: flags.issue,
    slug: flags.slug,
    platform: PLATFORM,
  });
  const durationSec = Number(flags.duration ?? 6);

  const pngPath = evidencePath(base, "png");
  if (captureScreenshot(adb, serial, pngPath)) {
    log(`screenshot → ${pngPath} (${statSync(pngPath).size} bytes)`);
  } else {
    log("screenshot failed (no file pulled)");
  }

  const mp4Path = evidencePath(base, "mp4");
  log(`recording ${durationSec}s → ${mp4Path}`);
  const recorded = await recordVideo(adb, serial, mp4Path, durationSec);
  log(
    recorded
      ? `recording → ${mp4Path} (${statSync(mp4Path).size} bytes)`
      : "recording produced no file",
  );

  const logcatPath = captureLogcat(
    adb,
    serial,
    evidencePath(base, "logcat.txt"),
  );
  log(logcatPath ? `logcat → ${logcatPath}` : "logcat empty");
  const backendLog = captureBackendLog(base);
  if (backendLog) log(`backend log → ${backendLog}`);

  mirrorToRecordings(PLATFORM, pngPath);
  if (recorded) mirrorToRecordings(PLATFORM, mp4Path);

  log("done");
}

main().catch((error) => {
  console.error(`[capture:${PLATFORM}] failed: ${error.message}`);
  process.exit(1);
});
