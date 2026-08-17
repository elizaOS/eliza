/**
 * Deterministic process-lifecycle coverage for iOS Simulator video capture.
 * The real xcrun recorder writes its MP4 trailer only while closing, so the
 * runner must await `close` rather than accepting an observed process exit.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveMediaProbeBinary } from "./device-video.mjs";
import { startIosSimulatorVideo } from "./ios-simulator-capture.mjs";

const tempDirs = [];
setDefaultTimeout(60_000);

function mp4Box(type, payload = Buffer.alloc(0)) {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, "ascii");
  payload.copy(box, 8);
  return box;
}

const EMPTY_MP4_SHELL = Buffer.concat([
  mp4Box("ftyp", Buffer.from("isom")),
  mp4Box("moov"),
]);
const UNDECODABLE_MP4 = Buffer.concat([
  mp4Box("ftyp", Buffer.from("isom")),
  mp4Box("moov"),
  mp4Box("mdat", Buffer.from("not-a-video-frame")),
]);

function writePlayableH264Video(outputPath) {
  const ffmpeg = resolveMediaProbeBinary();
  if (!ffmpeg) {
    throw new Error("ffmpeg is required to generate the H.264 test fixture");
  }
  const result = spawnSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=16x16:r=1:d=3",
      "-frames:v",
      "3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `could not generate H.264 fixture: ${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`,
    );
  }
  return outputPath;
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-simulator-capture-"));
  tempDirs.push(dir);
  return dir;
}

function fakeChild(onKill) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => onKill(child, signal);
  return child;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("iOS simulator video finalization", () => {
  it("waits for close before accepting a finalized recording", async () => {
    const artifactDir = tempDir();
    let recordingPath = null;
    let recordingArgs = null;
    const signals = [];
    const child = fakeChild((target, signal) => {
      signals.push(signal);
      target.exitCode = 0;
      setTimeout(() => {
        writePlayableH264Video(recordingPath);
        target.emit("close", 0, signal);
      }, 10);
      return true;
    });
    const recording = startIosSimulatorVideo({
      artifactDir,
      filename: "walkthrough.mp4",
      spawnProcess: (_command, args) => {
        recordingArgs = args;
        recordingPath = args.at(-1);
        return child;
      },
      closeTimeoutMs: 5_000,
      killTimeoutMs: 10,
    });

    expect(await recording.stop()).toBe(recording.localPath);
    expect(signals).toEqual(["SIGINT"]);
    expect(recordingArgs).toEqual([
      "simctl",
      "io",
      "booted",
      "recordVideo",
      "--codec",
      "h264",
      "--force",
      recording.localPath,
    ]);
    expect(fs.statSync(recording.localPath).size).toBeGreaterThan(0);
  });

  it("accepts a decodable MOV recording", async () => {
    const artifactDir = tempDir();
    let recordingPath = null;
    const child = fakeChild((target, signal) => {
      target.exitCode = 0;
      writePlayableH264Video(recordingPath);
      target.emit("close", 0, signal);
      return true;
    });
    const recording = startIosSimulatorVideo({
      artifactDir,
      filename: "walkthrough.mov",
      spawnProcess: (_command, args) => {
        recordingPath = args.at(-1);
        return child;
      },
      closeTimeoutMs: 5_000,
      killTimeoutMs: 10,
    });

    expect(await recording.stop()).toBe(recording.localPath);
    expect(fs.statSync(recording.localPath).size).toBeGreaterThan(0);
  });

  it.each([
    ["an empty ftyp+moov shell", "walkthrough.mp4", EMPTY_MP4_SHELL],
    [
      "a structurally plausible but non-decodable MP4",
      "walkthrough.mp4",
      UNDECODABLE_MP4,
    ],
    ["a non-decodable MOV container", "walkthrough.mov", Buffer.from("mov")],
  ])(
    "rejects %s after the recorder closes",
    async (_case, filename, contents) => {
      const artifactDir = tempDir();
      const signals = [];
      let recordingPath = null;
      const child = fakeChild((target, signal) => {
        signals.push(signal);
        target.exitCode = 0;
        fs.writeFileSync(recordingPath, contents);
        target.emit("close", 0, signal);
        return true;
      });
      const recording = startIosSimulatorVideo({
        artifactDir,
        filename,
        spawnProcess: (_command, args) => {
          recordingPath = args.at(-1);
          return child;
        },
        closeTimeoutMs: 100,
        killTimeoutMs: 10,
      });

      expect(await recording.stop()).toBeNull();
      expect(signals).toEqual(["SIGINT"]);
    },
  );

  it("escalates a recorder that does not close after SIGINT", async () => {
    const artifactDir = tempDir();
    const signals = [];
    const child = fakeChild((target, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") {
        setTimeout(() => target.emit("close", null, signal), 0);
      }
      return true;
    });
    const recording = startIosSimulatorVideo({
      artifactDir,
      spawnProcess: () => child,
      closeTimeoutMs: 1,
      killTimeoutMs: 5,
    });

    expect(await recording.stop()).toBeNull();
    expect(signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
  });
});
