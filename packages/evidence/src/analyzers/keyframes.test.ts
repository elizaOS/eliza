// video.keyframes against a tiny two-scene video generated in-test with ffmpeg.
// The whole test is skipped with an explicit reason when ffmpeg is absent, so it
// never fabricates a pass; when present it asserts the analyzer emits keyframe
// artifacts (including the guaranteed first/last frame) via a fake emitArtifact.
import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  extractKeyframes,
  ffmpegAvailable,
  videoKeyframesAnalyzer,
} from "./keyframes.ts";
import { makeTmpDir } from "./test-fixtures.ts";
import type { AnalyzerContext, AnalyzerInput } from "./types.ts";

const execFileAsync = promisify(execFile);
const dir = makeTmpDir();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const hasFfmpeg = await ffmpegAvailable();

/**
 * Build a 2-scene .mp4: 1s of solid red then 1s of solid blue, concatenated so
 * ffmpeg's scene detector sees exactly one hard cut between two colour blocks.
 */
async function makeTwoSceneVideo(out: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=64x64:d=1",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=64x64:d=1",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1[v]",
    "-map",
    "[v]",
    "-r",
    "10",
    "-pix_fmt",
    "yuv420p",
    out,
  ]);
}

const videoInput = (absolutePath: string): AnalyzerInput => ({
  entry: {
    path: "video/walkthrough/run.mp4",
    sha256: "0".repeat(64),
    bytes: 0,
    kind: "video",
    source: "walkthrough",
    producedBy: "test",
    createdAt: new Date().toISOString(),
  },
  absolutePath,
});

describe.skipIf(!hasFfmpeg.available)(
  "video.keyframes (ffmpeg present)",
  () => {
    it("extracts first + last (+ scene) frames from a two-scene video", async () => {
      const video = join(dir, "two-scene.mp4");
      await makeTwoSceneVideo(video);
      const outDir = join(dir, "frames");
      const frames = await extractKeyframes(video, outDir, 8);
      expect(frames.some((f) => f.kind === "first")).toBe(true);
      expect(frames.some((f) => f.kind === "last")).toBe(true);
      for (const f of frames) expect(existsSync(f.file)).toBe(true);
    });

    it("analyzer emits keyframe artifacts through emitArtifact", async () => {
      const video = join(dir, "two-scene-2.mp4");
      await makeTwoSceneVideo(video);
      const emitted: { bundlePath: string; kind: string }[] = [];
      const ctx: AnalyzerContext = {
        tier: "cpu",
        emitArtifact: async (filePath, options) => {
          emitted.push({ bundlePath: options.bundlePath, kind: options.kind });
          return {
            entry: {
              path: options.bundlePath,
              sha256: "0".repeat(64),
              bytes: 0,
              kind: options.kind,
              source: options.producedBy,
              producedBy: options.producedBy,
              createdAt: new Date().toISOString(),
            },
            absolutePath: filePath,
          };
        },
      };
      const result = await videoKeyframesAnalyzer.analyze(
        videoInput(video),
        ctx,
      );
      expect(result.status).toBe("ran");
      if (result.status !== "ran") return;
      const data = result.data as { keyframes: { bundlePath: string }[] };
      expect(data.keyframes.length).toBeGreaterThanOrEqual(2);
      expect(emitted.every((e) => e.kind === "keyframe")).toBe(true);
      expect(
        emitted.every((e) => e.bundlePath.startsWith("video/keyframes/")),
      ).toBe(true);
    });
  },
);

describe("video.keyframes degradation", () => {
  it("skips honestly without an emitArtifact handle", async () => {
    const result = await videoKeyframesAnalyzer.analyze(
      videoInput(join(dir, "nonexistent.mp4")),
      { tier: "cpu" },
    );
    expect(result.status).toBe("skipped-missing-tool");
    if (result.status === "skipped-missing-tool")
      expect(result.reason).toMatch(/emitArtifact/);
  });
});
