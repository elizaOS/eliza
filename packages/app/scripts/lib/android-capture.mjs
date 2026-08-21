/**
 * Shared script library for Android Capture capture and packaging helpers used
 * by app automation.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveAdb } from "./android-device.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const require = createRequire(import.meta.url);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isNonEmptyFile(filePath) {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    // error-policy:J4 an absent or unreadable capture is explicitly rejected
    // as invalid evidence rather than represented as a successful empty file.
    return false;
  }
}

function packagedBinary(name) {
  try {
    const loaded = require(name);
    return typeof loaded === "string" ? loaded : loaded?.path;
  } catch {
    // error-policy:J1 dependency resolution is translated into an unavailable
    // evidence tool; validation then fails closed at the capture boundary.
    return undefined;
  }
}

function executable(command) {
  if (!command) return false;
  const result = spawnSync(command, ["-version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function resolveFfprobe(env = process.env) {
  return [
    env.ELIZA_FFPROBE_BIN,
    "ffprobe",
    packagedBinary("ffprobe-static"),
  ].find(executable);
}

export function hasPositiveVideoDuration(
  filePath,
  { ffprobe = resolveFfprobe(), run = spawnSync } = {},
) {
  if (!ffprobe) return false;
  const result = run(
    ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,duration",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) return false;
  let probe;
  try {
    probe = JSON.parse(result.stdout);
  } catch {
    // error-policy:J3 ffprobe output is untrusted process input; malformed
    // metadata rejects the recording instead of fabricating valid duration.
    return false;
  }
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStreams = streams.filter(
    (stream) => stream?.codec_type === "video",
  );
  if (videoStreams.length === 0) return false;
  const durations = [
    probe.format?.duration,
    ...videoStreams.map((stream) => stream.duration),
  ].map(Number);
  return durations.some(
    (duration) => Number.isFinite(duration) && duration > 0,
  );
}

export function isFinalizedMp4(
  filePath,
  inspectMedia = hasPositiveVideoDuration,
) {
  if (!isNonEmptyFile(filePath)) return false;

  const fd = fs.openSync(filePath, "r");
  let structurallyComplete = false;
  try {
    const fileSize = fs.fstatSync(fd).size;
    const header = Buffer.alloc(16);
    let offset = 0;
    let sawFileType = false;
    let sawMovie = false;
    let sawMediaPayload = false;

    while (offset + 8 <= fileSize) {
      const bytesRead = fs.readSync(fd, header, 0, 16, offset);
      if (bytesRead < 8) return false;

      const size32 = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      let boxSize = size32;
      let headerSize = 8;
      if (size32 === 1) {
        if (bytesRead < 16) return false;
        const size64 = header.readBigUInt64BE(8);
        if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) return false;
        boxSize = Number(size64);
        headerSize = 16;
      } else if (size32 === 0) {
        boxSize = fileSize - offset;
      }

      if (boxSize < headerSize || offset + boxSize > fileSize) return false;
      if (type === "ftyp") sawFileType = true;
      if (type === "moov") sawMovie = true;
      if (type === "mdat" && boxSize > headerSize) sawMediaPayload = true;
      offset += boxSize;
    }

    structurallyComplete =
      sawFileType && sawMovie && sawMediaPayload && offset === fileSize;
  } finally {
    fs.closeSync(fd);
  }
  return structurallyComplete && inspectMedia(filePath);
}

/** Package collected recording segments and remove every rejected partial. */
export function finalizeAndroidRecordingSegments({
  segments,
  localPath,
  captureComplete,
  requireComplete,
  concatenate = concatSegments,
  validate = isFinalizedMp4,
  log = () => {},
}) {
  let accepted = false;
  try {
    if (segments.length === 0) return null;
    if (requireComplete && !captureComplete) {
      log("one or more Android screenrecord segments were incomplete");
      return null;
    }
    if (segments.length === 1) {
      fs.copyFileSync(segments[0], localPath);
    } else if (!concatenate(segments, localPath, log)) {
      if (requireComplete) {
        log("ffmpeg concat unavailable; complete recording is required");
        return null;
      }
      // ffmpeg unavailable/failed: keep the longest single segment so the run
      // still has watchable video rather than nothing.
      const longest = segments
        .map((file) => ({ file, size: fs.statSync(file).size }))
        .sort((a, b) => b.size - a.size)[0];
      fs.copyFileSync(longest.file, localPath);
      log(`ffmpeg concat unavailable; kept longest segment ${longest.file}`);
    }
    if (!isNonEmptyFile(localPath) || !validate(localPath)) {
      log(
        "chunked Android screenrecord was not a finalized positive-duration video",
      );
      return null;
    }
    accepted = true;
    log(`wrote chunked Android screenrecord: ${localPath}`);
    return localPath;
  } finally {
    for (const segment of segments) fs.rmSync(segment, { force: true });
    if (!accepted) fs.rmSync(localPath, { force: true });
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
      // Keep the adb shell transport alive while the device encoder handles
      // SIGINT and appends the trailing moov atom. Signaling the local adb
      // process here can hang up screenrecord before finalization.
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
      if (recorder.exitCode === null) {
        await Promise.race([
          new Promise((resolve) => recorder.once("close", resolve)),
          delay(3_000),
        ]);
      }
      if (recorder.exitCode === null) recorder.kill("SIGTERM");
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
      if (!isFinalizedMp4(localPath)) {
        fs.rmSync(localPath, { force: true });
        log(
          `Android screenrecord was not a finalized positive-duration video: ${remotePath}`,
        );
        return null;
      }
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
  requireComplete = false,
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
  let captureComplete = true;

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
      let settled = false;
      const done = (failed) => {
        if (settled) return;
        settled = true;
        if (failed) captureComplete = false;
        resolve(remotePath);
      };
      child.once("close", () => done(false));
      child.once("error", () => done(true));
    });
  };

  const loop = (async () => {
    let index = 0;
    while (!stopped) {
      const remotePath = await recordSegment(index);
      currentChild = null;
      const segmentLocal = path.join(artifactDir, `.${stem}-seg${index}.mp4`);
      const pull = spawnSync(
        adb,
        ["-s", serial, "pull", remotePath, segmentLocal],
        {
          stdio: "ignore",
          timeout: 60_000,
        },
      );
      spawnSync(adb, ["-s", serial, "shell", "rm", "-f", remotePath], {
        stdio: "ignore",
        timeout: 10_000,
      });
      if (pull.status === 0 && isFinalizedMp4(segmentLocal)) {
        segments.push(segmentLocal);
        log(`pulled Android screenrecord segment ${index}: ${segmentLocal}`);
      } else {
        captureComplete = false;
        fs.rmSync(segmentLocal, { force: true });
        log(`Android screenrecord segment ${index} was not finalized`);
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
      // Keep the local adb transport alive while the device encoder handles
      // SIGINT and appends the trailing moov atom. Bound that wait, then stop a
      // wedged transport so the segment loop can still fail closed.
      const exitDeadline = Date.now() + 15_000;
      while (
        currentChild &&
        currentChild.exitCode === null &&
        Date.now() < exitDeadline
      ) {
        await delay(500);
      }
      if (currentChild && currentChild.exitCode === null) {
        captureComplete = false;
        currentChild.kill("SIGTERM");
      }
      // The final pull contains the end of the user flow. Never package earlier
      // segments while that pull is still running: a valid-but-truncated MP4 is
      // not complete evidence.
      await loop;

      return finalizeAndroidRecordingSegments({
        segments,
        localPath,
        captureComplete,
        requireComplete,
        log,
      });
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
