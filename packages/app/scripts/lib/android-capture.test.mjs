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
  waitForCompleteAndroidSegments,
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
    const file = writeRecording(box("ftyp"), box("mdat"), box("moov"));
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

  test("waits for final-segment collection before packaging evidence", async () => {
    let releaseSegment;
    const segmentLoop = new Promise((resolve) => {
      releaseSegment = resolve;
    });
    let collectionFinished = false;
    const collection = waitForCompleteAndroidSegments(segmentLoop).then(() => {
      collectionFinished = true;
    });

    await Promise.resolve();
    expect(collectionFinished).toBe(false);
    releaseSegment();
    await collection;
    expect(collectionFinished).toBe(true);
  });
});
