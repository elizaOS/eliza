/**
 * Deterministic process-lifecycle coverage for iOS Simulator video capture.
 * The real xcrun recorder writes its MP4 trailer only while closing, so the
 * runner must await `close` rather than accepting an observed process exit.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startIosSimulatorVideo } from "./ios-simulator-capture.mjs";

const tempDirs = [];

function finalizedMp4() {
  const fileType = Buffer.alloc(12);
  fileType.writeUInt32BE(12, 0);
  fileType.write("ftyp", 4, "ascii");
  fileType.write("isom", 8, "ascii");
  const movie = Buffer.alloc(8);
  movie.writeUInt32BE(8, 0);
  movie.write("moov", 4, "ascii");
  return Buffer.concat([fileType, movie]);
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
        fs.writeFileSync(recordingPath, finalizedMp4());
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
      closeTimeoutMs: 100,
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
    expect(fs.readFileSync(recording.localPath)).toEqual(finalizedMp4());
  });

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
