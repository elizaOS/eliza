/**
 * Finalizes and packages Android screenshots, logcat receipts, and screen
 * recordings for device automation. Recordings are pulled only after the
 * device encoder exits and must contain complete ISO BMFF structure, so a
 * non-empty but truncated file can never count as review evidence.
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
    // error-policy:J3 an absent/unreadable artifact is explicitly invalid
    return false;
  }
}

function signalDeviceScreenRecord(adb, serial) {
  spawnSync(adb, ["-s", serial, "shell", "pkill", "-INT", "screenrecord"], {
    stdio: "ignore",
  });
}

async function waitForDeviceScreenRecordExit(adb, serial, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = spawnSync(
      adb,
      ["-s", serial, "shell", "pidof", "screenrecord"],
      { encoding: "utf8" },
    );
    if (pid.error) {
      throw new Error(`adb pidof screenrecord failed: ${pid.error.message}`);
    }
    if (!pid.stdout?.trim()) return;
    signalDeviceScreenRecord(adb, serial);
    await delay(500);
  }
  throw new Error(
    `Android screenrecord did not exit within ${timeoutMs}ms on ${serial}`,
  );
}

async function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("close", onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("close", onClose);
  });
}

async function waitForRemoteRecording(adb, serial, remotePath) {
  const deadline = Date.now() + 10_000;
  let previousSize = -1;
  while (Date.now() < deadline) {
    const stat = spawnSync(
      adb,
      ["-s", serial, "shell", "stat", "-c", "%s", remotePath],
      { encoding: "utf8" },
    );
    const size = Number.parseInt(stat.stdout?.trim() ?? "", 10);
    if (Number.isFinite(size) && size > 0 && size === previousSize) return size;
    previousSize = Number.isFinite(size) ? size : -1;
    await delay(500);
  }
  throw new Error(
    `Android screenrecord never produced a stable non-empty file: ${remotePath}`,
  );
}

function pullRemoteRecording(adb, serial, remotePath, localPath) {
  const pull = spawnSync(adb, ["-s", serial, "pull", remotePath, localPath], {
    encoding: "utf8",
  });
  if (pull.error || pull.status !== 0) {
    const detail =
      pull.error?.message ?? pull.stderr?.trim() ?? "unknown error";
    throw new Error(`adb pull failed for ${remotePath}: ${detail}`);
  }
  if (!isNonEmptyFile(localPath)) {
    throw new Error(`adb pull wrote an empty recording: ${localPath}`);
  }
  assertPlayableMp4(localPath);
  spawnSync(adb, ["-s", serial, "shell", "rm", "-f", remotePath], {
    stdio: "ignore",
  });
}

/** Parse top-level ISO BMFF boxes and require the boxes a watchable MP4 needs. */
export function inspectMp4(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const boxes = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) {
      return { valid: false, boxes, reason: "truncated box header" };
    }
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (bytes.length - offset < 16) {
        return { valid: false, boxes, reason: `truncated ${type} large size` };
      }
      const largeSize = bytes.readBigUInt64BE(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { valid: false, boxes, reason: `${type} box is too large` };
      }
      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    if (size < headerSize || offset + size > bytes.length) {
      return {
        valid: false,
        boxes,
        reason: `invalid ${type} box size ${size}`,
      };
    }
    boxes.push(type);
    offset += size;
  }
  const missing = ["ftyp", "mdat", "moov"].filter(
    (required) => !boxes.includes(required),
  );
  return missing.length === 0
    ? { valid: true, boxes, reason: null }
    : { valid: false, boxes, reason: `missing ${missing.join(", ")} box` };
}

/** Throw when a captured file is non-empty but not a structurally complete MP4. */
export function assertPlayableMp4(filePath) {
  const inspection = inspectMp4(fs.readFileSync(filePath));
  if (!inspection.valid) {
    throw new Error(
      `Android screenrecord is not a playable MP4 (${inspection.reason}): ${filePath}`,
    );
  }
  return inspection;
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

  let recorderError = null;
  recorder.once("error", (error) => {
    recorderError = error;
  });
  await delay(750);
  if (recorderError) {
    throw new Error(
      `Unable to start Android screenrecord: ${recorderError.message}`,
    );
  }
  log(`started Android screenrecord on ${serial}: ${remotePath}`);

  let stopPromise = null;
  return {
    localPath,
    remotePath,
    async stop() {
      stopPromise ??= (async () => {
        signalDeviceScreenRecord(adb, serial);
        await waitForDeviceScreenRecordExit(adb, serial);
        if (!(await waitForChildClose(recorder, 3_000))) {
          recorder.kill("SIGTERM");
          if (!(await waitForChildClose(recorder, 2_000))) {
            recorder.kill("SIGKILL");
            throw new Error(
              "adb screenrecord transport did not close after device exit",
            );
          }
        }
        if (recorderError) {
          throw new Error(
            `Android screenrecord failed: ${recorderError.message}`,
          );
        }
        await waitForRemoteRecording(adb, serial, remotePath);
        pullRemoteRecording(adb, serial, remotePath, localPath);
        log(`wrote Android screenrecord: ${localPath}`);
        return localPath;
      })();
      return stopPromise;
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
    return new Promise((resolve, reject) => {
      child.once("close", () => resolve(remotePath));
      child.once("error", reject);
    });
  };

  const loop = (async () => {
    let index = 0;
    while (!stopped) {
      const remotePath = await recordSegment(index);
      currentChild = null;
      const segmentLocal = path.join(artifactDir, `.${stem}-seg${index}.mp4`);
      await waitForRemoteRecording(adb, serial, remotePath);
      pullRemoteRecording(adb, serial, remotePath, segmentLocal);
      segments.push(segmentLocal);
      log(`pulled Android screenrecord segment ${index}: ${segmentLocal}`);
      index += 1;
    }
  })();

  await delay(750);
  log(`started chunked Android screenrecord on ${serial}: ${remoteBase}-seg*`);

  return {
    localPath,
    async stop() {
      stopped = true;
      signalDeviceScreenRecord(adb, serial);
      await waitForDeviceScreenRecordExit(adb, serial);
      const loopFinished = await Promise.race([
        loop.then(() => true),
        delay(8_000).then(() => false),
      ]);
      if (!loopFinished) {
        currentChild?.kill("SIGKILL");
        throw new Error(
          "chunked Android screenrecord did not finish after device exit",
        );
      }

      if (segments.length === 0) {
        throw new Error("chunked Android screenrecord produced no segments");
      }
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
      assertPlayableMp4(localPath);
      for (const segment of segments) fs.rmSync(segment, { force: true });
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
