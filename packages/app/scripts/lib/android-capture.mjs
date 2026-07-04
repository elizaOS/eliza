/**
 * adb capture primitives for the Android device/emulator e2e lanes: screen
 * recording (single-shot and chunked-for-long-walkthroughs), screenshots, and
 * a logcat tail, each pulled into an artifact dir. `screenrecord` on Android
 * hard-caps a single invocation at 180s, so `startAndroidChunkedScreenRecord`
 * rolls consecutive sub-180s chunks and, when `ffmpeg` is present, concats them
 * into one mp4 (otherwise it keeps the chunk files) — the gesture-matrix suites
 * (#12344) need one continuous video across a multi-leg walkthrough.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveAdb } from "./android-device.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Android's screenrecord caps a single invocation at 180s; chunked recording
// stays just under it so a chunk always finalizes cleanly before the next.
const MAX_CHUNK_SECONDS = 170;

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

function ffmpegAvailable() {
  return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
}

/**
 * Record a device screen across an unbounded duration by rolling consecutive
 * `screenrecord` chunks (each < the 180s cap) and concatenating them into one
 * mp4 when `ffmpeg` is available. Returns a handle whose `stop()` finalizes the
 * in-flight chunk, pulls every chunk, and joins them (falling back to the raw
 * chunk paths when ffmpeg is absent). Use this for the multi-leg gesture-matrix
 * walkthroughs that outrun a single 180s recording.
 */
export function startAndroidChunkedScreenRecord({
  adb = resolveAdb(),
  serial,
  artifactDir,
  filename = "screenrecord.mp4",
  bitRate = "4000000",
  chunkSeconds = MAX_CHUNK_SECONDS,
  log = () => {},
}) {
  if (!serial) throw new Error("serial is required for Android screenrecord");
  if (!artifactDir) {
    throw new Error("artifactDir is required for Android screenrecord");
  }

  ensureDir(artifactDir);
  const localPath = path.join(artifactDir, filename);
  fs.rmSync(localPath, { force: true });

  const limitSeconds = Math.min(MAX_CHUNK_SECONDS, Math.max(1, chunkSeconds));
  const chunkPaths = [];
  let stopped = false;
  let activeRecorder = null;
  let activeRemote = null;
  let loopDone = null;

  async function recordOneChunk(index) {
    const remote = `/sdcard/eliza-android-chunk-${index}.mp4`;
    const chunkLocal = path.join(
      artifactDir,
      `${path.parse(filename).name}.chunk-${String(index).padStart(3, "0")}.mp4`,
    );
    activeRemote = remote;
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
        String(bitRate),
        "--time-limit",
        String(limitSeconds),
        remote,
      ],
      { stdio: "ignore" },
    );
    recorder.on("error", () => {});
    activeRecorder = recorder;
    await Promise.race([
      new Promise((resolve) => recorder.once("close", resolve)),
      // Guard against a chunk that never self-terminates at the time limit.
      delay((limitSeconds + 5) * 1000).then(() => {
        if (recorder.exitCode === null) {
          spawnSync(
            adb,
            ["-s", serial, "shell", "pkill", "-INT", "screenrecord"],
            { stdio: "ignore" },
          );
          recorder.kill("SIGINT");
        }
      }),
    ]);
    activeRecorder = null;
    activeRemote = null;
    spawnSync(adb, ["-s", serial, "pull", remote, chunkLocal], {
      stdio: "ignore",
    });
    spawnSync(adb, ["-s", serial, "shell", "rm", "-f", remote], {
      stdio: "ignore",
    });
    if (isNonEmptyFile(chunkLocal)) {
      chunkPaths.push(chunkLocal);
      log(`wrote Android screenrecord chunk ${index}: ${chunkLocal}`);
    }
  }

  loopDone = (async () => {
    let index = 0;
    while (!stopped) {
      await recordOneChunk(index++);
    }
  })();

  return {
    localPath,
    async stop() {
      stopped = true;
      if (activeRecorder && activeRecorder.exitCode === null) {
        spawnSync(
          adb,
          ["-s", serial, "shell", "pkill", "-INT", "screenrecord"],
          { stdio: "ignore" },
        );
        activeRecorder.kill("SIGINT");
      }
      await Promise.race([loopDone, delay(10_000)]);
      if (activeRemote) {
        spawnSync(adb, ["-s", serial, "shell", "rm", "-f", activeRemote], {
          stdio: "ignore",
        });
      }
      if (chunkPaths.length === 0) return null;
      if (chunkPaths.length === 1) {
        fs.copyFileSync(chunkPaths[0], localPath);
        return localPath;
      }
      if (!ffmpegAvailable()) {
        log(
          `ffmpeg absent — kept ${chunkPaths.length} raw chunks (no concat): ` +
            chunkPaths.join(", "),
        );
        return chunkPaths;
      }
      const listPath = path.join(artifactDir, `${filename}.concat.txt`);
      fs.writeFileSync(
        listPath,
        `${chunkPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")}\n`,
      );
      const concat = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listPath,
          "-c",
          "copy",
          localPath,
        ],
        { stdio: "ignore" },
      );
      fs.rmSync(listPath, { force: true });
      if (concat.status === 0 && isNonEmptyFile(localPath)) {
        log(`concatenated ${chunkPaths.length} chunks → ${localPath}`);
        return localPath;
      }
      log("ffmpeg concat failed — returning raw chunk paths");
      return chunkPaths;
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
