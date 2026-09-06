/**
 * Verifies terminal video evidence using real FFmpeg files and decoded pixels.
 * Short final states and sparse frame timing must reach the analyzer's emitted
 * image; a scene-cut sample cannot substitute for the promised last frame.
 */
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { resolveFfmpegBinary } from "../ffmpeg-binaries.ts";
import {
  extractKeyframes,
  type KeyframesData,
  videoKeyframesAnalyzer,
} from "./keyframes.ts";
import { makeTmpDir } from "./test-fixtures.ts";
import type { AnalyzerContext } from "./types.ts";

const execFileAsync = promisify(execFile);
const dir = makeTmpDir();
const ffmpeg = await resolveFfmpegBinary();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function makeVideo(
  name: string,
  colors: string[],
  sparse = false,
  audioTail = false,
): Promise<string> {
  if (!ffmpeg.available) throw new Error(ffmpeg.reason);
  const output = join(dir, `${name}.mp4`);
  const inputs = colors.flatMap((color) => ["-f", "lavfi", "-i", color]);
  const filter =
    colors.length === 1
      ? "[0:v]null[v]"
      : `${colors.map((_, index) => `[${index}:v]`).join("")}concat=n=${colors.length}:v=1${sparse ? ",setpts=N*5/TB" : ""}[v]`;
  await execFileAsync(
    ffmpeg.bin,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      ...inputs,
      ...(audioTail
        ? ["-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono:d=3"]
        : []),
      "-filter_complex",
      filter,
      "-map",
      "[v]",
      ...(audioTail ? ["-map", `${colors.length}:a`, "-c:a", "aac"] : []),
      "-fps_mode",
      "vfr",
      "-pix_fmt",
      "yuv420p",
      output,
    ],
    { timeout: 30_000 },
  );
  return output;
}

async function expectGreen(file: string): Promise<void> {
  const { data } = await sharp(file)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(data[1]).toBeGreaterThan(220);
  expect(data[0]).toBeLessThan(30);
  expect(data[2]).toBeLessThan(30);
}

describe.skipIf(!ffmpeg.available)("actual terminal video frame", () => {
  it("emits the short terminal state as last even after earlier scene cuts", async () => {
    const video = await makeVideo("terminal", [
      "color=c=red:s=64x64:r=10:d=1",
      "color=c=blue:s=64x64:r=10:d=1",
      "color=c=lime:s=64x64:r=10:d=0.2",
    ]);
    const emitted = new Map<string, string>();
    const ctx: AnalyzerContext = {
      tier: "cpu",
      emitArtifact: async (file, options) => {
        const copy = join(dir, `emitted-${emitted.size}.png`);
        copyFileSync(file, copy);
        emitted.set(options.bundlePath, copy);
        return {
          absolutePath: copy,
          entry: {
            path: options.bundlePath,
            kind: options.kind,
            bytes: statSync(copy).size,
            sha256: "0".repeat(64),
            source: "test",
            producedBy: options.producedBy,
            createdAt: new Date().toISOString(),
          },
        };
      },
    };
    const result = await videoKeyframesAnalyzer.analyze(
      {
        absolutePath: video,
        entry: {
          path: "video/terminal.mp4",
          kind: "video",
          bytes: statSync(video).size,
          sha256: "0".repeat(64),
          source: "test",
          producedBy: "ffmpeg",
          createdAt: new Date().toISOString(),
        },
      },
      ctx,
    );
    expect(result.status).toBe("ran");
    if (result.status !== "ran") throw new Error("Analyzer did not run");
    const last = (result.data as KeyframesData).keyframes.find(
      (frame) => frame.kind === "last",
    );
    const image = last && emitted.get(last.bundlePath);
    if (!image) throw new Error("Analyzer did not emit a last-frame artifact");
    await expectGreen(image);
  });

  it("falls back when trailing audio leaves no video frame after the seek", async () => {
    if (!ffmpeg.available) throw new Error(ffmpeg.reason);
    const video = await makeVideo(
      "audio-tail",
      ["color=c=lime:s=64x64:r=10:d=0.1"],
      false,
      true,
    );
    const probe = join(dir, "tail-probe.png");
    await execFileAsync(
      ffmpeg.bin,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-sseof",
        "-1",
        "-i",
        video,
        "-fps_mode",
        "passthrough",
        "-update",
        "1",
        probe,
      ],
      { timeout: 30_000 },
    );
    expect(existsSync(probe)).toBe(false);
    const frames = await extractKeyframes(video, join(dir, "audio-tail"));
    const last = frames.find((frame) => frame.kind === "last");
    if (!last) throw new Error("Extractor did not return a last frame");
    await expectGreen(last.file);
  });

  it.each([
    {
      name: "single-frame",
      colors: ["color=c=lime:s=64x64:r=10:d=0.1"],
      sparse: false,
    },
    {
      name: "sparse-tail",
      colors: [
        "color=c=red:s=64x64:r=10:d=0.1",
        "color=c=lime:s=64x64:r=10:d=0.1",
      ],
      sparse: true,
    },
  ])(
    "extracts the actual last pixel for $name",
    async ({ name, colors, sparse }) => {
      const video = await makeVideo(name, colors, sparse);
      const frames = await extractKeyframes(video, join(dir, name));
      const last = frames.find((frame) => frame.kind === "last");
      if (!last) throw new Error("Extractor did not return a last frame");
      await expectGreen(last.file);
    },
  );
});
