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

function captureScreenshot(adb, serial, outPath) {
  const remote = "/sdcard/eliza-evidence-capture.png";
  spawnSync(adb, ["-s", serial, "shell", "rm", "-f", remote], {
    stdio: "ignore",
  });
  spawnSync(adb, ["-s", serial, "shell", "screencap", "-p", remote], {
    stdio: "ignore",
  });
  spawnSync(adb, ["-s", serial, "pull", remote, outPath], { stdio: "ignore" });
  spawnSync(adb, ["-s", serial, "shell", "rm", "-f", remote], {
    stdio: "ignore",
  });
  return existsSync(outPath) ? outPath : null;
}

async function recordVideo(adb, serial, outPath, durationSec) {
  const remote = "/sdcard/eliza-evidence-capture.mp4";
  spawnSync(adb, ["-s", serial, "shell", "rm", "-f", remote], {
    stdio: "ignore",
  });
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
  spawnSync(adb, ["-s", serial, "pull", remote, outPath], { stdio: "ignore" });
  spawnSync(adb, ["-s", serial, "shell", "rm", "-f", remote], {
    stdio: "ignore",
  });
  return existsSync(outPath) ? outPath : null;
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
