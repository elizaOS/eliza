// Runner integration: build a real bundle with a screenshot, a video, and an
// aria-tree, then analyze it at tier=cpu. Assert that one analysis.json lands
// beside each visual subject, that the per-analyzer statuses are honest (cpu
// heuristics ran, the gpu ocr.unlimited recorded skipped-tier, diff skipped for
// lack of a baseline), and that video keyframes were emitted and themselves
// analyzed. When ffmpeg is present the video path is exercised end to end; when
// absent the video analyzer records skipped-missing-tool.

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { createBundle } from "../bundle.ts";
import { EvidenceError } from "../errors.ts";
import { resolveFfmpegBinary } from "../ffmpeg-binaries.ts";
import { ffmpegAvailable } from "./keyframes.ts";
import { analyzeArtifacts } from "./runner.ts";
import { makeTmpDir, solidPng } from "./test-fixtures.ts";
import type { Analyzer } from "./types.ts";

const execFileAsync = promisify(execFile);
const scratch = makeTmpDir();
const hasFfmpeg = await ffmpegAvailable();
// Generate the clip with the SAME binary the gate above resolves (env, PATH,
// or bundled): a hardcoded "ffmpeg" fails instead of skipping on machines
// that only carry the bundled static binary.
const ffmpeg = await resolveFfmpegBinary();
const ffmpegBin = ffmpeg.available ? ffmpeg.bin : "ffmpeg";
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function makeVideo(out: string): Promise<void> {
  await execFileAsync(ffmpegBin, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=48x48:d=1",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=48x48:d=1",
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

describe("analyzeArtifacts (runner integration)", () => {
  it("writes one analysis.json per subject with honest statuses", async () => {
    const bundle = createBundle({
      rootDir: join(scratch, "runs"),
      provenance: {
        commit: "abcdef1234567",
        branch: "test",
        runner: "local",
        tier: "cpu",
        envFingerprint: {},
      },
      linkMode: "copy",
      runId: "20260101-000000-abcdef1-cpu",
    });

    // Seed source artifacts and add them to the bundle.
    const shot = await solidPng(join(scratch, "shot.png"), [20, 20, 22]);
    const tree = join(scratch, "tree.yaml");
    writeFileSync(tree, '- main:\n  - heading "Home" [level=1]\n');
    const shotEntry = await bundle.addArtifact(shot, {
      kind: "screenshot",
      source: "audit",
      producedBy: "test",
    });
    const treeEntry = await bundle.addArtifact(tree, {
      kind: "html-tree",
      source: "audit",
      producedBy: "test",
    });
    const entries = [shotEntry, treeEntry];
    if (hasFfmpeg.available) {
      const video = join(scratch, "run.mp4");
      await makeVideo(video);
      entries.push(
        await bundle.addArtifact(video, {
          kind: "video",
          source: "walkthrough",
          producedBy: "test",
        }),
      );
    }

    const { subjects } = await analyzeArtifacts(bundle.dir, entries, {
      tier: "cpu",
      bundle,
    });

    // Screenshot subject: cpu heuristics ran, gpu ocr.unlimited skipped-tier,
    // diff analyzers skipped for lack of a baseline resolver.
    const shotSubject = subjects.find((s) => s.artifact === shotEntry.path);
    expect(shotSubject).toBeDefined();
    const r = shotSubject?.document.results ?? {};
    expect(r["ocr.tesseract"]).toBeDefined();
    expect(r["color.palette"].status).toBe("ran");
    expect(r["color.corners"].status).toBe("ran");
    expect(r["brand.rules"].status).toBe("ran");
    expect(r["hash.perceptual"].status).toBe("ran");
    expect(r["ocr.unlimited"].status).toBe("skipped-tier");
    expect(r["diff.change"].status).toBe("skipped-missing-tool");
    expect(r["diff.region"].status).toBe("skipped-missing-tool");

    // analysis.json landed beside the screenshot and is valid.
    expect(shotSubject?.documentPath).toBe(`${shotEntry.path}.analysis.json`);
    const docOnDisk = join(
      bundle.dir,
      ...(shotSubject?.documentPath as string).split("/"),
    );
    expect(existsSync(docOnDisk)).toBe(true);
    const parsed = JSON.parse(readFileSync(docOnDisk, "utf8"));
    expect(parsed.schema).toBe(1);
    expect(parsed.artifact).toBe(shotEntry.path);

    // Tree subject: only tree.aria applies.
    const treeSubject = subjects.find((s) => s.artifact === treeEntry.path);
    expect(treeSubject?.document.results["tree.aria"].status).toBe("ran");

    if (hasFfmpeg.available) {
      // The video subject emitted keyframes, which were themselves analyzed as
      // their own subjects (image heuristics fanned over them).
      const videoSubject = subjects.find((s) => s.artifact.endsWith("run.mp4"));
      expect(videoSubject?.document.results["video.keyframes"].status).toBe(
        "ran",
      );
      const keyframeSubjects = subjects.filter((s) =>
        s.artifact.startsWith("video/keyframes/"),
      );
      expect(keyframeSubjects.length).toBeGreaterThanOrEqual(2);
      // A keyframe subject gets the image heuristics too.
      expect(keyframeSubjects[0].document.results["brand.rules"].status).toBe(
        "ran",
      );
    }

    await bundle.finalize();
    // Keyframe extraction + the analyzer fan-out overrun vitest's 5s default
    // under parallel suite load; the explicit budget matches the driver suite's.
  }, 120_000);

  it("returns documents without a bundle and skips emit-requiring analyzers", async () => {
    // Analyze a bare screenshot with no bundle: documents are returned but not
    // written, and video keyframes would skip (no emitArtifact).
    const looseDir = join(scratch, "loose");
    mkdirSync(looseDir, { recursive: true });
    await solidPng(join(looseDir, "a.png"), [200, 110, 40]);
    const entry = {
      path: "a.png",
      sha256: "0".repeat(64),
      bytes: 0,
      kind: "screenshot" as const,
      source: "test",
      producedBy: "test",
      createdAt: new Date().toISOString(),
    };
    const { subjects } = await analyzeArtifacts(looseDir, [entry], {
      tier: "cpu",
    });
    expect(subjects).toHaveLength(1);
    expect(subjects[0].documentPath).toBeUndefined();
    expect(subjects[0].document.results["brand.rules"].status).toBe("ran");
  });

  it("records a throwing analyzer as failed with its message, isolated from the rest", async () => {
    const looseDir = join(scratch, "failed-path");
    mkdirSync(looseDir, { recursive: true });
    await solidPng(join(looseDir, "b.png"), [40, 40, 40]);
    const entry = {
      path: "b.png",
      sha256: "0".repeat(64),
      bytes: 0,
      kind: "screenshot" as const,
      source: "test",
      producedBy: "test",
      createdAt: new Date().toISOString(),
    };
    const boom: Analyzer = {
      name: "test.boom",
      tier: "cpu",
      kinds: ["screenshot"],
      analyze() {
        throw new EvidenceError("synthetic analyzer failure", {
          code: "TEST_BOOM",
        });
      },
    };
    const healthy: Analyzer = {
      name: "test.healthy",
      tier: "cpu",
      kinds: ["screenshot"],
      analyze: () => ({ status: "ran", data: { ok: true } }),
    };
    const { subjects } = await analyzeArtifacts(looseDir, [entry], {
      tier: "cpu",
      analyzers: [boom, healthy],
    });
    const results = subjects[0].document.results;
    // The throw becomes an honest failed record — message surfaced, no data.
    expect(results["test.boom"].status).toBe("failed");
    expect(results["test.boom"].reason).toContain("synthetic analyzer failure");
    expect(results["test.boom"].data).toBeUndefined();
    expect(results["test.boom"].durationMs).toBeGreaterThanOrEqual(0);
    // One broken analyzer cannot take down the rest of the matrix.
    expect(results["test.healthy"].status).toBe("ran");
  });
});
