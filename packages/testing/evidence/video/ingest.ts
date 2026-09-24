/**
 * Ingest a single walkthrough video into a bundle as first-class, analyzed
 * evidence. A video is not directly readable by the image heuristics, so this is
 * a two-stage pipeline: (1) normalize the input to a canonical MP4 and place it
 * at `video/<granularity>s/<slug>.mp4`; (2) run the `video.keyframes` analyzer
 * to emit scene-cut + boundary keyframes into the bundle, then fan the full
 * image-analyzer matrix (OCR, palette, brand, corners, phash) over those
 * keyframes — so the video gains OCR/colour/QA coverage, not just an eyeball.
 *
 * Granularity is the evidence-lane axis from #14545: `element` (one widget's
 * micro-interaction), `feature` (a flow like send-message), `walkthrough` (a
 * whole-app tour). It selects the placement directory and is stamped on the
 * artifact's `source`/`producedBy` provenance so a reviewer can tell a
 * send-button hover clip from a five-view tour without opening either.
 *
 * When ffmpeg/ffprobe are absent the video is still ingested under its original
 * extension (its bytes matter), but normalization and keyframe analysis record
 * explicit skipped-missing-tool results — the returned report carries them,
 * never a silent success or mislabeled MP4.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SubjectAnalysis } from "../analyzers/runner.ts";
import { analyzeArtifacts } from "../analyzers/runner.ts";
import type { EvidenceBundle } from "../bundle.ts";
import { EvidenceError } from "../errors.ts";
import type { ArtifactEntry, Tier } from "../schema.ts";
import { type NormalizeOutcome, normalizeVideo } from "./normalize.ts";

/** The three evidence granularities video lanes produce. */
export const VIDEO_GRANULARITIES = [
  "element",
  "feature",
  "walkthrough",
] as const;
export type VideoGranularity = (typeof VIDEO_GRANULARITIES)[number];

/** Placement directory for a granularity: `video/elements`, `video/features`, `video/walkthroughs`. */
function granularityDir(granularity: VideoGranularity): string {
  return `video/${granularity}s`;
}

/** Options for {@link ingestVideo}. */
export interface IngestVideoOptions {
  /** Which evidence lane this video belongs to. */
  granularity: VideoGranularity;
  /** Filesystem-safe subject id; becomes `<slug>.mp4`. */
  slug: string;
  /** Optional test lane (e2e, native, …) recorded on the artifact. */
  lane?: string;
  /** Producer id recorded on the artifact `source`, e.g. `walkthrough-driver`. */
  source: string;
  /** Tool/script that produced the video, recorded on `producedBy`. */
  producedBy: string;
  /** Tier the keyframe fan-out runs at; keyframe analysis is cpu-tier. */
  tier?: Tier;
}

/** Result of ingesting one video into a bundle. */
export interface IngestVideoResult {
  /** The video artifact entry as placed in the bundle. */
  video: ArtifactEntry;
  /** How the input reached canonical MP4 (or why normalization was skipped). */
  normalize: NormalizeOutcome;
  /** Per-subject analysis for the video and every emitted keyframe. */
  analysis: SubjectAnalysis[];
  /** Count of keyframe artifacts the video.keyframes analyzer emitted. */
  keyframeCount: number;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Reject a slug that would escape its placement dir or collide on case. */
function assertSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new EvidenceError(
      `video slug must match ${SLUG_PATTERN} (lowercase alphanumeric + dashes): ${slug}`,
      { code: "VIDEO_SLUG_INVALID", context: { slug } },
    );
  }
}

/**
 * Normalize `file` to MP4, place it at `video/<granularity>s/<slug>.mp4`, and
 * run keyframe extraction + the image-analyzer fan-out over the emitted
 * keyframes. Returns the placed video entry, the normalization outcome, and the
 * per-subject analysis documents (one for the video, one per keyframe).
 */
export async function ingestVideo(
  bundle: EvidenceBundle,
  file: string,
  options: IngestVideoOptions,
): Promise<IngestVideoResult> {
  assertSlug(options.slug);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    // error-policy:J2 context-adding rethrow — a vanished source is a hard
    // ingest failure, not an empty video.
    throw new EvidenceError(`video source file missing: ${file}`, {
      code: "VIDEO_SOURCE_MISSING",
      cause: error,
      context: { file },
    });
  }
  if (!stat.isFile()) {
    throw new EvidenceError(`video source is not a file: ${file}`, {
      code: "VIDEO_SOURCE_MISSING",
      context: { file },
    });
  }

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-video-"));
  const canonical = path.join(scratchDir, `${options.slug}.mp4`);
  let normalize: NormalizeOutcome;
  try {
    normalize = await normalizeVideo(file, canonical);
    // When normalization is skipped (no ffmpeg), the input bytes are ingested
    // as-is under the source extension; the skip is reported so the reviewer
    // knows the container may not be GitHub-inline-renderable.
    const sourceForPlacement =
      normalize.status === "skipped-missing-tool" ? file : canonical;
    const extension =
      normalize.status === "skipped-missing-tool"
        ? sourceExtension(file)
        : ".mp4";
    const bundlePath = `${granularityDir(options.granularity)}/${options.slug}${extension}`;
    const video = await bundle.addArtifact(sourceForPlacement, {
      kind: "video",
      source: options.source,
      ...(options.lane !== undefined ? { lane: options.lane } : {}),
      producedBy: options.producedBy,
      bundlePath,
    });

    // Fan keyframe extraction + image analyzers over just this video. The runner
    // emits keyframes through the bundle, then analyzes them in the same pass.
    const { subjects } = await analyzeArtifacts(bundle.dir, [video], {
      tier: options.tier ?? "cpu",
      bundle,
    });
    const keyframeCount = subjects.filter(
      (subject) => subject.artifact !== video.path,
    ).length;
    return { video, normalize, analysis: subjects, keyframeCount };
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

/** Preserve the producer's extension only when it is safe for a bundle path. */
function sourceExtension(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return /^\.[a-z0-9]+$/.test(extension) ? extension : ".video";
}
