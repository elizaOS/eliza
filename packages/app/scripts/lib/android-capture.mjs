import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveAdb } from "./android-device.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isNonEmptyFile(filePath) {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

export async function startAndroidScreenRecord({
  adb = resolveAdb(),
  serial,
  artifactDir,
  filename = "screenrecord.mp4",
  remotePath = `/sdcard/${filename}`,
  bitRate = "4000000",
  timeLimitSeconds = 180,
  log = () => {},
}) {
  if (!serial) throw new Error("serial is required for Android screenrecord");
  if (!artifactDir) {
    throw new Error("artifactDir is required for Android screenrecord");
  }

  ensureDir(artifactDir);
  const localPath = path.join(artifactDir, filename);
  fs.rmSync(localPath, { force: true });

  spawnSync(adb, ["-s", serial, "shell", "rm", "-f", remotePath], {
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
      String(bitRate),
      "--time-limit",
      String(timeLimitSeconds),
      remotePath,
    ],
    { stdio: "ignore" },
  );

  recorder.on("error", () => {});
  await delay(750);
  log(`started Android screenrecord on ${serial}: ${remotePath}`);

  return {
    localPath,
    remotePath,
    async stop() {
      spawnSync(adb, ["-s", serial, "shell", "pkill", "-INT", "screenrecord"], {
        stdio: "ignore",
      });
      if (recorder.exitCode === null) recorder.kill("SIGINT");
      await Promise.race([
        new Promise((resolve) => recorder.once("close", resolve)),
        delay(3_000),
      ]);
      spawnSync(adb, ["-s", serial, "pull", remotePath, localPath], {
        stdio: "ignore",
      });
      spawnSync(adb, ["-s", serial, "shell", "rm", "-f", remotePath], {
        stdio: "ignore",
      });
      if (!isNonEmptyFile(localPath)) return null;
      log(`wrote Android screenrecord: ${localPath}`);
      return localPath;
    },
  };
}

export function captureAndroidScreenshot({
  adb = resolveAdb(),
  serial,
  artifactDir,
  filename = "screenshot.png",
  log = () => {},
}) {
  if (!serial) throw new Error("serial is required for Android screenshot");
  if (!artifactDir) {
    throw new Error("artifactDir is required for Android screenshot");
  }

  ensureDir(artifactDir);
  const localPath = path.join(artifactDir, filename);
  const result = spawnSync(adb, ["-s", serial, "exec-out", "screencap", "-p"]);
  if (result.status !== 0 || !result.stdout?.length) {
    const detail = result.stderr?.toString("utf8").trim();
    throw new Error(
      `adb screencap failed for ${serial}${detail ? `: ${detail}` : ""}`,
    );
  }
  fs.writeFileSync(localPath, result.stdout);
  if (!isNonEmptyFile(localPath)) {
    throw new Error(`adb screencap wrote an empty file: ${localPath}`);
  }
  log(`wrote Android screenshot: ${localPath}`);
  return localPath;
}

export function captureAndroidLogcat({
  adb = resolveAdb(),
  serial,
  artifactDir,
  filename = "logcat.txt",
  lines = 500,
  log = () => {},
}) {
  if (!serial) throw new Error("serial is required for Android logcat");
  if (!artifactDir)
    throw new Error("artifactDir is required for Android logcat");

  ensureDir(artifactDir);
  const localPath = path.join(artifactDir, filename);
  const result = spawnSync(
    adb,
    ["-s", serial, "logcat", "-d", "-t", String(lines)],
    { encoding: "utf8" },
  );
  fs.writeFileSync(
    localPath,
    result.status === 0
      ? result.stdout
      : result.stderr || `adb logcat exited with ${result.status}\n`,
  );
  log(`wrote Android logcat: ${localPath}`);
  return localPath;
}
