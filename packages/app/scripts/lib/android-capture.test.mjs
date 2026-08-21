/**
 * Validates the MP4 finalization boundary used before Android recordings are
 * accepted as evidence.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isFinalizedMp4,
  startAndroidScreenRecord,
} from "./android-capture.mjs";

const files = [];

afterEach(() => {
  for (const file of files.splice(0)) fs.rmSync(file, { force: true });
});

function box(type, payload = Buffer.alloc(0)) {
  const value = Buffer.alloc(8 + payload.length);
  value.writeUInt32BE(value.length, 0);
  value.write(type, 4, 4, "ascii");
  payload.copy(value, 8);
  return value;
}

function mdatWithFrames(bytes = 64) {
  return box("mdat", Buffer.alloc(bytes, 0x21));
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

describe("Android screenrecord finalization", () => {
  test("accepts a complete MP4 with file type and movie metadata", () => {
    const file = writeRecording(box("ftyp"), mdatWithFrames(), box("moov"));
    expect(isFinalizedMp4(file)).toBe(true);
  });

  test("rejects the exact truncated shape produced before moov is flushed", () => {
    const file = writeRecording(box("ftyp"), mdatWithFrames());
    expect(isFinalizedMp4(file)).toBe(false);
  });

  test("rejects a partial trailing box", () => {
    const partialMovie = Buffer.from([
      0x00, 0x00, 0x00, 0x10, 0x6d, 0x6f, 0x6f, 0x76, 0x00,
    ]);
    const file = writeRecording(box("ftyp"), mdatWithFrames(), partialMovie);
    expect(isFinalizedMp4(file)).toBe(false);
  });

  test("rejects a moov salvaged without any sample data", () => {
    const file = writeRecording(box("ftyp"), box("mdat"), box("moov"));
    expect(isFinalizedMp4(file)).toBe(false);
  });

  test("rejects a moov written before the sample data it indexes", () => {
    const file = writeRecording(box("ftyp"), box("moov"), mdatWithFrames());
    expect(isFinalizedMp4(file)).toBe(false);
  });
});

/**
 * Drives the real recorder against a fake adb so the stop() contract is
 * exercised end to end: stop() must not return until the final segment pull has
 * landed, and requireComplete must discard evidence when any segment is
 * unfinalized.
 */
describe("chunked Android screenrecord collection", () => {
  const dirs = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function fakeAdb(mode) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-fake-adb-"));
    dirs.push(dir);
    const adb = path.join(dir, "adb");
    // The pull sleeps: a stop() that failed to await the segment loop would
    // package evidence before the final segment exists on disk.
    const script = [
      "#!/bin/sh",
      "op=",
      'for a in "$@"; do',
      '  case "$a" in pull) op=pull;; screenrecord) op=record;; esac',
      "done",
      'if [ "$op" = record ]; then sleep 2; exit 0; fi',
      'if [ "$op" = pull ]; then',
      "  sleep 1",
      '  for out in "$@"; do :; done',
      '  printf "\\000\\000\\000\\010ftyp" > "$out"',
      '  printf "\\000\\000\\000\\014mdatXXXX" >> "$out"',
      mode === "complete"
        ? '  printf "\\000\\000\\000\\010moov" >> "$out"'
        : "  :",
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n");
    fs.writeFileSync(adb, script, { mode: 0o755 });
    return adb;
  }

  async function runRecorder(mode) {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-android-art-"));
    dirs.push(artifactDir);
    const recorder = await startAndroidScreenRecord({
      adb: fakeAdb(mode),
      serial: "emulator-5554",
      artifactDir,
      filename: "flow.mp4",
      requireComplete: true,
      segmentSeconds: 1,
      log: () => {},
    });
    return { recorder, artifactDir };
  }

  test("stop() waits for the in-flight final pull before packaging", async () => {
    const { recorder, artifactDir } = await runRecorder("complete");
    const result = await recorder.stop();
    expect(result).toBe(path.join(artifactDir, "flow.mp4"));
    expect(isFinalizedMp4(result)).toBe(true);
    // No staging segment may survive a packaged run.
    expect(fs.readdirSync(artifactDir).filter((f) => f.startsWith("."))).toEqual([]);
  }, 30_000);

  test("stop() fails closed and packages nothing when a segment is unfinalized", async () => {
    const { recorder, artifactDir } = await runRecorder("truncated");
    expect(await recorder.stop()).toBeNull();
    expect(fs.existsSync(path.join(artifactDir, "flow.mp4"))).toBe(false);
    expect(fs.readdirSync(artifactDir)).toEqual([]);
  }, 30_000);
});
