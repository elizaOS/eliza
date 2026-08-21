/**
 * Validates the MP4 finalization boundary used before Android recordings are
 * accepted as evidence.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  finalizeAndroidRecordingSegments,
  hasPositiveVideoDuration,
  isFinalizedMp4,
} from "./android-capture.mjs";

const paths = [];

afterEach(() => {
  for (const target of paths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
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
    `eliza-android-recording-${process.pid}-${paths.length}.mp4`,
  );
  fs.writeFileSync(file, Buffer.concat(boxes));
  paths.push(file);
  return file;
}

function mediaPayload() {
  return Buffer.from([0x00, 0x00, 0x00, 0x01]);
}

function segmentFixture(count = 1) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-android-segments-"),
  );
  paths.push(root);
  const segments = Array.from({ length: count }, (_, index) => {
    const segment = path.join(root, `.recording-seg${index}.mp4`);
    fs.writeFileSync(segment, `segment-${index}`);
    return segment;
  });
  return {
    root,
    segments,
    localPath: path.join(root, "recording.mp4"),
  };
}

describe("Android screenrecord finalization", () => {
  test("accepts structure only when media inspection proves positive video duration", () => {
    const file = writeRecording(
      box("ftyp"),
      box("mdat", mediaPayload()),
      box("moov"),
    );
    expect(isFinalizedMp4(file, () => true)).toBe(true);
    expect(isFinalizedMp4(file, () => false)).toBe(false);
  });

  test("rejects finalized metadata without media payload", () => {
    const file = writeRecording(box("ftyp"), box("moov"));
    expect(isFinalizedMp4(file, () => true)).toBe(false);
  });

  test("rejects an empty media box even when movie metadata exists", () => {
    const file = writeRecording(box("ftyp"), box("mdat"), box("moov"));
    expect(isFinalizedMp4(file, () => true)).toBe(false);
  });

  test("requires a video stream with positive ffprobe duration", () => {
    const probe = (payload) => (_bin, args) => {
      expect(args.at(-1)).toBe("/evidence/walkthrough.mp4");
      return {
        error: undefined,
        status: 0,
        stdout: JSON.stringify(payload),
      };
    };
    expect(
      hasPositiveVideoDuration("/evidence/walkthrough.mp4", {
        ffprobe: "/tools/ffprobe",
        run: probe({
          format: { duration: "1.25" },
          streams: [{ codec_type: "video" }],
        }),
      }),
    ).toBe(true);
    expect(
      hasPositiveVideoDuration("/evidence/walkthrough.mp4", {
        ffprobe: "/tools/ffprobe",
        run: probe({
          format: { duration: "0" },
          streams: [{ codec_type: "video", duration: "0" }],
        }),
      }),
    ).toBe(false);
    expect(
      hasPositiveVideoDuration("/evidence/walkthrough.mp4", {
        ffprobe: "/tools/ffprobe",
        run: probe({
          format: { duration: "2" },
          streams: [{ codec_type: "audio" }],
        }),
      }),
    ).toBe(false);
  });

  test("rejects the exact truncated shape produced before moov is flushed", () => {
    const file = writeRecording(box("ftyp"), box("mdat", mediaPayload()));
    expect(isFinalizedMp4(file, () => true)).toBe(false);
  });

  test("rejects a partial trailing box", () => {
    const partialMovie = Buffer.from([
      0x00, 0x00, 0x00, 0x10, 0x6d, 0x6f, 0x6f, 0x76, 0x00,
    ]);
    const file = writeRecording(
      box("ftyp"),
      box("mdat", mediaPayload()),
      partialMovie,
    );
    expect(isFinalizedMp4(file, () => true)).toBe(false);
  });
});

describe("Android segment packaging", () => {
  test("rejects a failed final pull and removes accepted earlier segments", () => {
    const fixture = segmentFixture();
    const result = finalizeAndroidRecordingSegments({
      ...fixture,
      captureComplete: false,
      requireComplete: true,
      validate: () => true,
    });

    expect(result).toBeNull();
    expect(fs.existsSync(fixture.localPath)).toBe(false);
    expect(fs.existsSync(fixture.segments[0])).toBe(false);
  });

  test("rejects failed required concatenation and removes all partials", () => {
    const fixture = segmentFixture(2);
    const result = finalizeAndroidRecordingSegments({
      ...fixture,
      captureComplete: true,
      requireComplete: true,
      concatenate: (_segments, localPath) => {
        fs.writeFileSync(localPath, "partial concat");
        return false;
      },
      validate: () => true,
    });

    expect(result).toBeNull();
    expect(fs.existsSync(fixture.localPath)).toBe(false);
    expect(fixture.segments.every((file) => !fs.existsSync(file))).toBe(true);
  });

  test("cleans partials when concatenation throws", () => {
    const fixture = segmentFixture(2);
    expect(() =>
      finalizeAndroidRecordingSegments({
        ...fixture,
        captureComplete: true,
        requireComplete: true,
        concatenate: (_segments, localPath) => {
          fs.writeFileSync(localPath, "partial concat");
          throw new Error("concat process failed");
        },
        validate: () => true,
      }),
    ).toThrow("concat process failed");

    expect(fs.existsSync(fixture.localPath)).toBe(false);
    expect(fixture.segments.every((file) => !fs.existsSync(file))).toBe(true);
  });

  test("keeps the accepted package and removes its source segment", () => {
    const fixture = segmentFixture();
    const result = finalizeAndroidRecordingSegments({
      ...fixture,
      captureComplete: true,
      requireComplete: true,
      validate: () => true,
    });

    expect(result).toBe(fixture.localPath);
    expect(fs.readFileSync(fixture.localPath, "utf8")).toBe("segment-0");
    expect(fs.existsSync(fixture.segments[0])).toBe(false);
  });

  test("removes copied output when final validation fails", () => {
    const fixture = segmentFixture();
    const result = finalizeAndroidRecordingSegments({
      ...fixture,
      captureComplete: true,
      requireComplete: true,
      validate: () => false,
    });

    expect(result).toBeNull();
    expect(fs.existsSync(fixture.localPath)).toBe(false);
    expect(fs.existsSync(fixture.segments[0])).toBe(false);
  });
});
