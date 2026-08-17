/**
 * Validates the MP4 finalization boundary used before Android recordings are
 * accepted as evidence.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureAndroidScreenshot,
  isFinalizedMp4,
  stopAndroidScreenrecordProcess,
} from "./android-capture.mjs";
import { resolveMediaProbeBinary } from "./device-video.mjs";

const files = [];
setDefaultTimeout(60_000);

afterEach(() => {
  for (const file of files.splice(0)) {
    fs.rmSync(file, { force: true, recursive: true });
  }
});

function box(type, payload = Buffer.alloc(0)) {
  const value = Buffer.alloc(8 + payload.length);
  value.writeUInt32BE(value.length, 0);
  value.write(type, 4, 4, "ascii");
  payload.copy(value, 8);
  return value;
}

function writeRecording(...boxes) {
  const file = path.join(
    os.tmpdir(),
    `eliza-android-recording-${process.pid}-${files.length}.mp4`,
  );
  fs.writeFileSync(file, Buffer.concat(boxes));
  files.push(file);
  return file;
}

function writePlayableH264Recording() {
  const ffmpeg = resolveMediaProbeBinary();
  if (!ffmpeg) throw new Error("ffmpeg is required for the MP4 fixture");
  const file = path.join(
    os.tmpdir(),
    `eliza-android-recording-${process.pid}-${files.length}.mp4`,
  );
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
      file,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `could not generate H.264 fixture: ${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`,
    );
  }
  files.push(file);
  return file;
}

describe("Android screenrecord finalization", () => {
  test("signals once while the encoder flushes and waits for process exit", async () => {
    let signals = 0;
    let polls = 0;
    const exited = await stopAndroidScreenrecordProcess({
      signal: () => {
        signals += 1;
      },
      isRunning: () => {
        polls += 1;
        return polls < 4;
      },
      wait: async () => {},
      timeoutMs: 1_000,
    });

    expect(exited).toBe(true);
    expect(signals).toBe(1);
    expect(polls).toBe(4);
  });

  test("accepts a complete MP4 with file type and movie metadata", () => {
    const file = writePlayableH264Recording();
    expect(isFinalizedMp4(file)).toBe(true);
  });

  test("rejects the exact truncated shape produced before moov is flushed", () => {
    const file = writeRecording(box("ftyp"), box("mdat"));
    expect(isFinalizedMp4(file)).toBe(false);
  });

  test("rejects a partial trailing box", () => {
    const partialMovie = Buffer.from([
      0x00, 0x00, 0x00, 0x10, 0x6d, 0x6f, 0x6f, 0x76, 0x00,
    ]);
    const file = writeRecording(box("ftyp"), box("mdat"), partialMovie);
    expect(isFinalizedMp4(file)).toBe(false);
  });
});

describe("Android failure capture", () => {
  test("bounds screenshot diagnostics when adb stops responding", () => {
    const fakeAdb = path.join(
      os.tmpdir(),
      `eliza-hanging-adb-${process.pid}-${files.length}`,
    );
    fs.writeFileSync(fakeAdb, "#!/bin/sh\nwhile :; do :; done\n");
    fs.chmodSync(fakeAdb, 0o755);
    files.push(fakeAdb);
    const artifactDir = path.join(
      os.tmpdir(),
      `eliza-adb-capture-${process.pid}-${files.length}`,
    );
    fs.mkdirSync(artifactDir);
    files.push(artifactDir);

    const startedAt = Date.now();
    expect(() =>
      captureAndroidScreenshot({
        adb: fakeAdb,
        serial: "lost-device",
        artifactDir,
        timeoutMs: 50,
      }),
    ).toThrow(/adb screencap failed/);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
