/**
 * Exercises browser-video MP4 validation (#29774) with real ffmpeg/ffprobe
 * processes: one valid H.264 yuv420p transcode passes, and every rejected
 * shape (empty, symlink, malformed, wrong codec, wrong pixel format, extra
 * audio stream, wrong resolution, non-MP4 container) fails with a typed reason.
 * Runners without ffmpeg/ffprobe report an explicit skip.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  BrowserVideoEvidenceError,
  resolveFfprobe,
  validateBrowserVideoMp4,
} from "./browser-video-evidence.ts";

const ffprobe = resolveFfprobe();
const ffmpegAvailable = (() => {
  const result = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-version"], {
    stdio: "ignore",
  });
  return !result.error && result.status === 0;
})();
const describeWithMedia = describe.skipIf(!ffprobe || !ffmpegAvailable);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixtureDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-video-"));
  roots.push(root);
  return root;
}

function encode(output: string, extra: string[], size = "320x200"): string {
  const result = spawnSync(
    process.env.FFMPEG_PATH ?? "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=${size}:rate=10:duration=1`,
      ...extra,
      output,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`fixture encode failed: ${result.stderr}`);
  }
  return output;
}

function rejection(file: string, expected?: [number, number]): string {
  try {
    validateBrowserVideoMp4(file, {
      ffprobe: ffprobe as string,
      expectedWidth: expected?.[0],
      expectedHeight: expected?.[1],
    });
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserVideoEvidenceError);
    return (error as BrowserVideoEvidenceError).reason;
  }
  throw new Error("expected validation to reject");
}

const H264 = ["-an", "-c:v", "libx264", "-pix_fmt", "yuv420p"];

describeWithMedia("validateBrowserVideoMp4", () => {
  test("accepts one H.264 yuv420p MP4 stream at the expected resolution", () => {
    const file = encode(path.join(fixtureDir(), "ok.mp4"), H264);
    const probe = validateBrowserVideoMp4(file, {
      ffprobe: ffprobe as string,
      expectedWidth: 320,
      expectedHeight: 200,
    });
    expect(probe).toMatchObject({
      container: "mp4",
      codec: "h264",
      pixelFormat: "yuv420p",
      width: 320,
      height: 200,
    });
    expect(probe.durationSeconds).toBeGreaterThan(0);
    expect(probe.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  test("rejects missing, empty, symlinked, and malformed outputs", () => {
    const dir = fixtureDir();
    expect(rejection(path.join(dir, "absent.mp4"))).toBe("missing");
    const empty = path.join(dir, "empty.mp4");
    fs.writeFileSync(empty, "");
    expect(rejection(empty)).toBe("empty");
    const valid = encode(path.join(dir, "valid.mp4"), H264);
    const link = path.join(dir, "link.mp4");
    fs.symlinkSync(valid, link);
    expect(rejection(link)).toBe("not_regular_file");
    const garbage = path.join(dir, "garbage.mp4");
    fs.writeFileSync(garbage, "not a video container");
    expect(rejection(garbage)).toBe("probe_failed");
  }, 30_000);

  test("rejects wrong codec, pixel format, container, streams, and size", () => {
    const dir = fixtureDir();
    expect(
      rejection(encode(path.join(dir, "mpeg4.mp4"), ["-an", "-c:v", "mpeg4"])),
    ).toBe("wrong_codec");
    expect(
      rejection(
        encode(path.join(dir, "yuv444.mp4"), [
          "-an",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv444p",
        ]),
      ),
    ).toBe("wrong_pixel_format");
    expect(rejection(encode(path.join(dir, "clip.mkv"), H264))).toBe(
      "not_mp4_container",
    );
    const withAudio = path.join(dir, "audio.mp4");
    const audio = spawnSync(
      process.env.FFMPEG_PATH ?? "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=320x200:rate=10:duration=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        withAudio,
      ],
      { encoding: "utf8" },
    );
    expect(audio.status).toBe(0);
    expect(rejection(withAudio)).toBe("unexpected_stream_count");
    expect(
      rejection(encode(path.join(dir, "size.mp4"), H264), [1440, 900]),
    ).toBe("wrong_dimensions");
  }, 60_000);
});
