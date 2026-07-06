/**
 * `video.keyframes` — scene-cut keyframe extraction. A walkthrough video is not
 * directly analyzable by the image heuristics, so this analyzer shells to
 * ffmpeg to pull representative frames — scene changes (`select='gt(scene,0.3)'`)
 * plus the guaranteed first and last frame — and emits each as a `keyframe`
 * artifact under `video/keyframes/<slug>/`. The runner then fans the image
 * analyzers over those keyframes through its normal loop, so a video is covered
 * by OCR, palette, brand, corners, and phash without any of them knowing about
 * video.
 *
 * ffmpeg resolves from env, PATH, then the installed `ffmpeg-static` package;
 * only when every source is unavailable does the analyzer record
 * `skipped-missing-tool`. Emitting artifacts requires the runner's
 * `ctx.emitArtifact` handle; without it (analysis over a bare directory with no
 * bundle) the analyzer skips with that reason.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { EvidenceError } from "../errors.ts";
import { resolveFfmpegBinary } from "../ffmpeg-binaries.ts";
import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerFragment,
  AnalyzerInput,
} from "./types.ts";

const execFileAsync = promisify(execFile);

/** Default cap on emitted scene-cut keyframes (first/last are always added). */
const DEFAULT_MAX_SCENE_FRAMES = 12;

/** One emitted keyframe's placement. */
export interface KeyframeRecord {
  /** Bundle-relative path of the emitted keyframe artifact. */
  bundlePath: string;
  /** Origin: a scene cut, or the guaranteed first/last frame. */
  kind: "scene" | "first" | "last";
}

/** Payload of a `ran` `video.keyframes` result. */
export interface KeyframesData {
  keyframes: KeyframeRecord[];
}

/** Whether ffmpeg is invocable, with a reason when not. */
export async function ffmpegAvailable(): Promise<
  { available: true } | { available: false; reason: string }
> {
  const resolved = await resolveFfmpegBinary();
  return resolved.available ? { available: true } : resolved;
}

/**
 * Extract scene-cut frames plus the first and last frame of `videoPath` into
 * `outDir` as zero-padded PNGs. Returns the written file paths tagged by origin.
 * Scene detection and the boundary frames are separate ffmpeg passes so a video
 * with no detected scene cut still yields the two boundary frames.
 */
export async function extractKeyframes(
  videoPath: string,
  outDir: string,
  maxSceneFrames = DEFAULT_MAX_SCENE_FRAMES,
): Promise<{ file: string; kind: "scene" | "first" | "last" }[]> {
  const ffmpeg = await resolveFfmpegBinary();
  if (!ffmpeg.available) {
    throw new EvidenceError(ffmpeg.reason, { code: "FFMPEG_UNAVAILABLE" });
  }
  fs.mkdirSync(outDir, { recursive: true });
  const scenePattern = path.join(outDir, "scene-%03d.png");
  await execFileAsync(
    ffmpeg.bin,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-vf",
      "select='gt(scene,0.3)'",
      "-vsync",
      "vfr",
      "-frames:v",
      String(maxSceneFrames),
      scenePattern,
    ],
    { timeout: 120_000 },
  );
  const first = path.join(outDir, "first.png");
  const last = path.join(outDir, "last.png");
  await execFileAsync(
    ffmpeg.bin,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-frames:v",
      "1",
      first,
    ],
    { timeout: 60_000 },
  );
  // Seek to the final frame: read the whole stream and keep only the last.
  await execFileAsync(
    ffmpeg.bin,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-sseof",
      "-1",
      "-i",
      videoPath,
      "-update",
      "1",
      "-frames:v",
      "1",
      last,
    ],
    { timeout: 60_000 },
  );
  const out: { file: string; kind: "scene" | "first" | "last" }[] = [
    { file: first, kind: "first" },
  ];
  for (const name of fs.readdirSync(outDir).sort()) {
    if (name.startsWith("scene-") && name.endsWith(".png")) {
      out.push({ file: path.join(outDir, name), kind: "scene" });
    }
  }
  out.push({ file: last, kind: "last" });
  return out;
}

/**
 * Derive a filesystem-safe slug from an artifact's bundle path. Squashing
 * punctuation to `-` is lossy (`a/b.mp4` and `a-b.mp4` collapse to the same
 * slug), so a short hash of the exact path is appended — two distinct videos
 * can never write keyframes into each other's directory.
 */
export function slugForVideo(bundlePath: string): string {
  const slug = bundlePath
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const hash = createHash("sha256")
    .update(bundlePath)
    .digest("hex")
    .slice(0, 8);
  return slug === "" ? hash : `${slug}-${hash}`;
}

export const videoKeyframesAnalyzer: Analyzer = {
  name: "video.keyframes",
  tier: "cpu",
  kinds: ["video"],
  async analyze(
    input: AnalyzerInput,
    ctx: AnalyzerContext,
  ): Promise<AnalyzerFragment> {
    if (!ctx.emitArtifact) {
      return {
        status: "skipped-missing-tool",
        reason: "keyframe extraction requires a bundle (ctx.emitArtifact)",
      };
    }
    const availability = await ffmpegAvailable();
    if (!availability.available) {
      return { status: "skipped-missing-tool", reason: availability.reason };
    }
    const slug = slugForVideo(input.entry.path);
    const scratch = fs.mkdtempSync(
      path.join(os.tmpdir(), "evidence-keyframes-"),
    );
    try {
      const frames = await extractKeyframes(input.absolutePath, scratch);
      const keyframes: KeyframeRecord[] = [];
      let index = 0;
      for (const frame of frames) {
        const name = `${String(index).padStart(3, "0")}-${frame.kind}.png`;
        const bundlePath = `video/keyframes/${slug}/${name}`;
        const emitted = await ctx.emitArtifact(frame.file, {
          kind: "keyframe",
          bundlePath,
          producedBy: "video.keyframes",
        });
        keyframes.push({ bundlePath: emitted.entry.path, kind: frame.kind });
        index++;
      }
      const data: KeyframesData = { keyframes };
      return { status: "ran", data };
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  },
};
