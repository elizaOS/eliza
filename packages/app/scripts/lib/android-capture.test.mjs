/**
 * Validates the MP4 finalization boundary used before Android recordings are
 * accepted as evidence: the structural box-walk in isFinalizedMp4, the
 * ffprobe-backed playability gate in hasPositiveVideoDuration, and the
 * segment-packaging boundary in finalizeAndroidRecordingSegments. The
 * "chunked Android screenrecord collection" suite below drives the real
 * startChunkedAndroidScreenRecord()/stop() lifecycle against a fake adb (and a
 * fake ffprobe) rather than injected mocks, because that is the only coverage
 * that catches stop() packaging evidence before the in-flight final segment
 * pull — and now the in-flight ffprobe duration check — actually lands.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  finalizeAndroidRecordingSegments,
  hasPositiveVideoDuration,
  isFinalizedMp4,
  startChunkedAndroidScreenRecord,
} from "./android-capture.mjs";

const require = createRequire(import.meta.url);

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
    const probe = (payload) => (_bin, args, options) => {
      expect(args.at(-1)).toBe("/evidence/walkthrough.mp4");
      expect(options.timeout).toBeGreaterThan(0);
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
          streams: [
            {
              codec_type: "video",
              width: 1080,
              height: 1920,
              nb_read_frames: "3",
            },
          ],
        }),
      }),
    ).toBe(true);
    expect(
      hasPositiveVideoDuration("/evidence/walkthrough.mp4", {
        ffprobe: "/tools/ffprobe",
        run: probe({
          format: { duration: "0" },
          streams: [
            {
              codec_type: "video",
              width: 1080,
              height: 1920,
              duration: "0",
              nb_read_frames: "3",
            },
          ],
        }),
      }),
    ).toBe(false);
    expect(
      hasPositiveVideoDuration("/evidence/walkthrough.mp4", {
        ffprobe: "/tools/ffprobe",
        run: probe({
          format: { duration: "2" },
          streams: [
            {
              codec_type: "video",
              width: 1080,
              height: 1920,
              nb_read_frames: "0",
            },
          ],
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

/**
 * Resolves a real ffprobe binary the same way the library does (env override,
 * then a system binary, then the packaged ffprobe-static devDependency) so
 * the "real ffprobe" test below is skipped with an explicit reason instead of
 * silently passing when no binary is available, per repo evidence policy: an
 * absent capability must never read as a passing/empty result.
 */
function resolveRealFfprobeForTest() {
  const candidates = [process.env.ELIZA_FFPROBE_BIN, "ffprobe"];
  try {
    const packaged = require("ffprobe-static");
    candidates.push(typeof packaged === "string" ? packaged : packaged?.path);
  } catch {
    // ffprobe-static is not installed in this checkout; fall through to the
    // other candidates instead of failing resolution outright.
  }
  return candidates.find((bin) => {
    if (!bin) return false;
    const probe = spawnSync(bin, ["-version"], { stdio: "ignore" });
    return !probe.error && probe.status === 0;
  });
}

describe("hasPositiveVideoDuration against a real ffprobe", () => {
  const realFfprobe = resolveRealFfprobeForTest();

  test.skipIf(!realFfprobe)(
    "reports a real encoded MP4 as playable" +
      (realFfprobe
        ? ""
        : " (SKIPPED: no ffprobe binary resolved in this environment)"),
    () => {
      // 1-second, 16x16, H.264 + AAC fixture produced with:
      //   ffmpeg -f lavfi -i color=c=black:s=16x16:d=1 \
      //     -f lavfi -i anullsrc=r=8000:cl=mono -shortest -pix_fmt yuv420p \
      //     -c:v libx264 -preset ultrafast -c:a aac -movflags +faststart -t 1 minimal.mp4
      const fixtureBase64 =
        "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";
      const file = path.join(
        os.tmpdir(),
        `eliza-real-ffprobe-fixture-${process.pid}.mp4`,
      );
      fs.writeFileSync(file, Buffer.from(fixtureBase64, "base64"));
      paths.push(file);

      expect(hasPositiveVideoDuration(file)).toBe(true);
    },
  );
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

/**
 * Drives the real chunked recorder against a fake adb and a fake ffprobe so
 * the full stop() contract is exercised end to end through the actual
 * isFinalizedMp4()/hasPositiveVideoDuration() gate, not an injected
 * `validate`/`ffprobe` stub: stop() must not return until the final segment
 * pull has landed, and the segment loop's ffprobe playability check must
 * fail closed on a structurally-finalized-but-zero-duration segment.
 */
describe("chunked Android screenrecord collection", () => {
  const dirs = [];
  let savedFfprobeBin;
  let ffprobeBinSaved = false;

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (ffprobeBinSaved) {
      if (savedFfprobeBin === undefined) delete process.env.ELIZA_FFPROBE_BIN;
      else process.env.ELIZA_FFPROBE_BIN = savedFfprobeBin;
      ffprobeBinSaved = false;
    }
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

  // Stands in for the ffprobe-static/system binary resolveFfprobe() would
  // otherwise resolve: reports a positive duration for a "complete" capture
  // and a zero duration for a "truncated" one, so the playability gate added
  // to isFinalizedMp4() is exercised without depending on a real codec.
  function fakeFfprobe(mode) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-fake-ffprobe-"));
    dirs.push(dir);
    const ffprobe = path.join(dir, "ffprobe");
    const duration = mode === "complete" ? "1.5" : "0";
    const frames = mode === "complete" ? "30" : "0";
    const script = [
      "#!/bin/sh",
      'if [ "$1" = "-version" ]; then',
      "  echo fake-ffprobe",
      "  exit 0",
      "fi",
      `printf '{"format":{"duration":"${duration}"},"streams":[{"codec_type":"video","width":1080,"height":1920,"duration":"${duration}","nb_read_frames":"${frames}"}]}'`,
      "exit 0",
      "",
    ].join("\n");
    fs.writeFileSync(ffprobe, script, { mode: 0o755 });
    return ffprobe;
  }

  async function runRecorder(mode) {
    const artifactDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-android-art-"),
    );
    dirs.push(artifactDir);
    savedFfprobeBin = process.env.ELIZA_FFPROBE_BIN;
    ffprobeBinSaved = true;
    process.env.ELIZA_FFPROBE_BIN = fakeFfprobe(mode);
    const recorder = await startChunkedAndroidScreenRecord({
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
    expect(
      fs.readdirSync(artifactDir).filter((f) => f.startsWith(".")),
    ).toEqual([]);
  }, 30_000);

  test("stop() fails closed and packages nothing when a segment is unfinalized", async () => {
    const { recorder, artifactDir } = await runRecorder("truncated");
    expect(await recorder.stop()).toBeNull();
    expect(fs.existsSync(path.join(artifactDir, "flow.mp4"))).toBe(false);
    expect(fs.readdirSync(artifactDir)).toEqual([]);
  }, 30_000);
});
