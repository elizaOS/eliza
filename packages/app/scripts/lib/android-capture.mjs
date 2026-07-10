/**
 * Shared script library for Android Capture capture and packaging helpers used
 * by app automation.
 */
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
      // The local adb process closing does not mean the on-device screenrecord
      // has finished: it still has to append the trailing moov atom, and
      // pulling at that instant yields an unplayable MP4. Wait (bounded) for
      // the device-side process to exit, re-sending SIGINT while it lives —
      // a single pkill has been observed not landing.
      const exitDeadline = Date.now() + 15_000;
      while (Date.now() < exitDeadline) {
        const pid = spawnSync(
          adb,
          ["-s", serial, "shell", "pidof", "screenrecord"],
          { encoding: "utf8" },
        );
        if (!pid.stdout || pid.stdout.trim() === "") break;
        spawnSync(
          adb,
          ["-s", serial, "shell", "pkill", "-INT", "screenrecord"],
          { stdio: "ignore" },
        );
        await delay(500);
      }
      // Belt over the pid check: require the remote file size to hold steady
      // across consecutive samples so a mid-flush pull can never grab a
      // truncated file (covers a transient pidof miss or the exit-wait
      // timing out above).
      let settledSize = -1;
      for (let i = 0; i < 10; i += 1) {
        const stat = spawnSync(
          adb,
          ["-s", serial, "shell", "stat", "-c", "%s", remotePath],
          { encoding: "utf8" },
        );
        const size = Number.parseInt(stat.stdout?.trim() ?? "", 10);
        if (Number.isFinite(size) && size > 0 && size === settledSize) break;
        settledSize = Number.isFinite(size) ? size : -1;
        await delay(500);
      }
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

/**
 * Record a gesture walkthrough that outruns `screenrecord`'s hard 180s per-file
 * cap: record back-to-back capped segments on the device, pull each as it ends,
 * and concat them into one mp4 with ffmpeg (`-c copy`, no re-encode — every
 * segment shares the same encoder settings). Falls back to the single recorded
 * segment when ffmpeg is missing or only one segment exists. There is a
 * sub-second gap between segments (the pull + respawn window); evidence video
 * tolerates it, so it is not stitched over.
 */
export async function startChunkedAndroidScreenRecord({
  adb = resolveAdb(),
  serial,
  artifactDir,
  filename = "screenrecord.mp4",
  segmentSeconds = 170,
  bitRate = "4000000",
  log = () => {},
}) {
  if (!serial) throw new Error("serial is required for Android screenrecord");
  if (!artifactDir) {
    throw new Error("artifactDir is required for Android screenrecord");
  }

  ensureDir(artifactDir);
  const localPath = path.join(artifactDir, filename);
  fs.rmSync(localPath, { force: true });
  const stem = path.basename(filename, path.extname(filename));
  const remoteBase = `/sdcard/${stem}`;

  const segments = [];
  let stopped = false;
  let currentChild = null;

  const recordSegment = (index) => {
    const remotePath = `${remoteBase}-seg${String(index).padStart(3, "0")}.mp4`;
    spawnSync(adb, ["-s", serial, "shell", "rm", "-f", remotePath], {
      stdio: "ignore",
    });
    const child = spawn(
      adb,
      [
        "-s",
        serial,
        "shell",
        "screenrecord",
        "--bit-rate",
        String(bitRate),
        "--time-limit",
        String(Math.min(180, Math.max(1, segmentSeconds))),
        remotePath,
      ],
      { stdio: "ignore" },
    );
    currentChild = child;
    return new Promise((resolve) => {
      const done = () => resolve(remotePath);
      child.once("close", done);
      child.once("error", done);
    });
  };

  const loop = (async () => {
    let index = 0;
    while (!stopped) {
      const remotePath = await recordSegment(index);
      currentChild = null;
      const segmentLocal = path.join(artifactDir, `.${stem}-seg${index}.mp4`);
      spawnSync(adb, ["-s", serial, "pull", remotePath, segmentLocal], {
        stdio: "ignore",
      });
      spawnSync(adb, ["-s", serial, "shell", "rm", "-f", remotePath], {
        stdio: "ignore",
      });
      if (isNonEmptyFile(segmentLocal)) {
        segments.push(segmentLocal);
        log(`pulled Android screenrecord segment ${index}: ${segmentLocal}`);
      }
      index += 1;
    }
  })();

  await delay(750);
  log(`started chunked Android screenrecord on ${serial}: ${remoteBase}-seg*`);

  return {
    localPath,
    async stop() {
      stopped = true;
      spawnSync(adb, ["-s", serial, "shell", "pkill", "-INT", "screenrecord"], {
        stdio: "ignore",
      });
      if (currentChild && currentChild.exitCode === null) {
        currentChild.kill("SIGINT");
      }
      await Promise.race([loop, delay(8_000)]);

      if (segments.length === 0) return null;
      if (segments.length === 1) {
        fs.copyFileSync(segments[0], localPath);
      } else if (!concatSegments(segments, localPath, log)) {
        // ffmpeg unavailable/failed: keep the longest single segment so the run
        // still has watchable video rather than nothing.
        const longest = segments
          .map((file) => ({ file, size: fs.statSync(file).size }))
          .sort((a, b) => b.size - a.size)[0];
        fs.copyFileSync(longest.file, localPath);
        log(`ffmpeg concat unavailable; kept longest segment ${longest.file}`);
      }
      for (const segment of segments) fs.rmSync(segment, { force: true });
      if (!isNonEmptyFile(localPath)) return null;
      log(`wrote chunked Android screenrecord: ${localPath}`);
      return localPath;
    },
  };
}

function concatSegments(segments, outPath, log) {
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (probe.status !== 0) return false;
  const listPath = `${outPath}.concat.txt`;
  fs.writeFileSync(
    listPath,
    `${segments.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n")}\n`,
  );
  const result = spawnSync(
    "ffmpeg",
    ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath],
    { stdio: "ignore" },
  );
  fs.rmSync(listPath, { force: true });
  if (result.status !== 0 || !isNonEmptyFile(outPath)) {
    log(`ffmpeg concat failed with status ${result.status}`);
    return false;
  }
  return true;
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
