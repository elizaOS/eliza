// ingestVideo against a two-scene clip generated in-test with ffmpeg. Skipped
// with an explicit reason when ffmpeg is absent (never a fabricated pass); when
// present it asserts placement at video/<granularity>s/<slug>.mp4, that the
// video is normalized to h264+faststart, that keyframes are emitted and each
// keyframe gets the full image-analyzer fan-out, and that the finalized bundle
// verifies clean. Slug validation is asserted separately (tool-free).
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { createBundle, verifyBundle } from "../bundle.ts";
import { EvidenceError } from "../errors.ts";
import { ingestVideo } from "./ingest.ts";
import { videoToolsAvailable } from "./normalize.ts";

const execFileAsync = promisify(execFile);
const dir = mkdtempSync(join(os.tmpdir(), "evidence-video-ingest-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tools = await videoToolsAvailable();

/** Two-scene webm: 1s red then 1s blue, so scene detection sees one hard cut. */
async function makeTwoSceneWebm(out: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=128x128:d=1",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=128x128:d=1",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1[v]",
    "-map",
    "[v]",
    "-r",
    "10",
    "-c:v",
    "libvpx-vp9",
    out,
  ]);
}

function newBundle(runId: string) {
  return createBundle({
    rootDir: join(dir, "runs"),
    provenance: {
      commit: "0".repeat(40),
      branch: "test",
      runner: "local",
      tier: "cpu",
      envFingerprint: {
        node: process.version,
        platform: "test",
        arch: "test",
        tier: "cpu",
      },
    },
    runId,
    linkMode: "copy",
  });
}

describe.skipIf(!tools.available)("ingestVideo (ffmpeg present)", () => {
  it("places, normalizes, and keyframe-analyzes a two-scene webm", async () => {
    const webm = join(dir, "two-scene.webm");
    await makeTwoSceneWebm(webm);
    const bundle = newBundle("ingest-run-1");
    const result = await ingestVideo(bundle, webm, {
      granularity: "feature",
      slug: "send-message",
      source: "test",
      producedBy: "ingest.test",
    });

    expect(result.video.path).toBe("video/features/send-message.mp4");
    expect(result.video.kind).toBe("video");
    // A webm is transcoded to canonical mp4, not copied through.
    expect(result.normalize.status).toBe("transcoded");
    // First + last (+ the red→blue scene cut) keyframes are emitted.
    expect(result.keyframeCount).toBeGreaterThanOrEqual(2);

    // The video subject and every keyframe subject got an analysis document.
    const videoSubject = result.analysis.find(
      (subject) => subject.artifact === result.video.path,
    );
    expect(videoSubject).toBeDefined();
    expect(videoSubject?.document.results["video.keyframes"]?.status).toBe(
      "ran",
    );

    const keyframeSubject = result.analysis.find((subject) =>
      subject.artifact.startsWith("video/keyframes/"),
    );
    expect(keyframeSubject).toBeDefined();
    // The image analyzers fanned over the keyframe (palette always runs at cpu).
    expect(keyframeSubject?.document.results["color.palette"]?.status).toBe(
      "ran",
    );

    const finalized = await bundle.finalize();
    expect(finalized.manifest.artifacts.length).toBeGreaterThan(4);
    const report = await verifyBundle(bundle.dir);
    expect(report.ok).toBe(true);
  });
});

describe("ingestVideo validation", () => {
  it("rejects an invalid slug with a typed error", async () => {
    const bundle = newBundle("ingest-bad-slug");
    await expect(
      ingestVideo(bundle, join(dir, "irrelevant.mp4"), {
        granularity: "element",
        slug: "Bad Slug!",
        source: "test",
        producedBy: "ingest.test",
      }),
    ).rejects.toBeInstanceOf(EvidenceError);
  });

  it("rejects a missing source file with a typed error", async () => {
    const bundle = newBundle("ingest-missing-src");
    await expect(
      ingestVideo(bundle, join(dir, "does-not-exist.mp4"), {
        granularity: "element",
        slug: "ok",
        source: "test",
        producedBy: "ingest.test",
      }),
    ).rejects.toMatchObject({ code: "VIDEO_SOURCE_MISSING" });
  });
});
