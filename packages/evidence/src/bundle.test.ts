/**
 * Real-filesystem tests for the bundle builder and verifier: byte-stable
 * manifests under an injected clock, hardlink vs copy materialization, path
 * collision/traversal refusal, single-use lifecycle, and tamper detection.
 * Everything runs against tmp dirs — no mocks of the code under test; the
 * only injected seam is the link function (the EXDEV condition cannot be
 * created portably inside one tmp volume).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BundleProvenance } from "./bundle.ts";
import {
  createBundle,
  EvidenceBundle,
  formatRunId,
  verifyBundle,
} from "./bundle.ts";
import { EvidenceError, EvidenceValidationError } from "./errors.ts";

const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";

const PROVENANCE: BundleProvenance = {
  commit: COMMIT,
  branch: "feat/test",
  runner: "local",
  tier: "cpu",
  envFingerprint: {
    node: "v24.0.0",
    platform: "linux",
    arch: "x64",
    tier: "cpu",
  },
};

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-bundle-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Deterministic clock: starts at a fixed instant, advances 1 s per call. */
function fixedClock(
  startMs = Date.parse("2026-07-05T12:00:00.000Z"),
): () => Date {
  let calls = 0;
  return () => new Date(startMs + 1000 * calls++);
}

function writeFixture(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

async function buildSampleBundle(root: string, sources: string) {
  const bundle = createBundle({
    rootDir: root,
    provenance: PROVENANCE,
    now: fixedClock(),
  });
  await bundle.addArtifact(writeFixture(sources, "shot.png", "png-bytes"), {
    kind: "screenshot",
    source: "aesthetic-audit",
    producedBy: "audit:app",
    relativePath: "desktop/shot.png",
  });
  await bundle.addArtifact(writeFixture(sources, "run.jsonl", "{}\n"), {
    kind: "trajectory",
    source: "scenario-runner",
    lane: "scenario",
    producedBy: "eliza-scenarios",
  });
  await bundle.addArtifact(writeFixture(sources, "server.log", "log line\n"), {
    kind: "log",
    source: "e2e-recordings",
    lane: "e2e",
    producedBy: "run-all.mjs",
  });
  return bundle;
}

describe("formatRunId", () => {
  it("derives <utc stamp>-<shortsha>-<tier>", () => {
    const id = formatRunId(new Date("2026-07-05T18:32:45.123Z"), COMMIT, "gpu");
    expect(id).toBe("20260705-183245-abcdef0-gpu");
  });
});

describe("EvidenceBundle", () => {
  it("places artifacts by the documented kind→family mapping", async () => {
    const bundle = await buildSampleBundle(tmpDir(), tmpDir());
    const result = await bundle.finalize();
    expect(result.manifest.artifacts.map((entry) => entry.path)).toEqual([
      "lanes/e2e/logs/server.log",
      "trajectories/scenario-runner/run.jsonl",
      "visual/aesthetic-audit/desktop/shot.png",
    ]);
    for (const entry of result.manifest.artifacts) {
      const stored = path.join(bundle.dir, ...entry.path.split("/"));
      expect(fs.statSync(stored).size).toBe(entry.bytes);
    }
  });

  it("honors an explicit bundlePath override", async () => {
    const sources = tmpDir();
    const bundle = createBundle({
      rootDir: tmpDir(),
      provenance: PROVENANCE,
      now: fixedClock(),
    });
    const entry = await bundle.addArtifact(
      writeFixture(sources, "analysis.json", "{}"),
      {
        kind: "analysis",
        source: "analyzer",
        producedBy: "analyzer",
        bundlePath: "visual/aesthetic-audit/desktop/analysis.json",
      },
    );
    expect(entry.path).toBe("visual/aesthetic-audit/desktop/analysis.json");
  });

  it("rejects relativePath + bundlePath together", async () => {
    const sources = tmpDir();
    const bundle = createBundle({
      rootDir: tmpDir(),
      provenance: PROVENANCE,
      now: fixedClock(),
    });
    await expect(
      bundle.addArtifact(writeFixture(sources, "x.png", "x"), {
        kind: "screenshot",
        source: "s",
        producedBy: "p",
        relativePath: "a.png",
        bundlePath: "visual/s/a.png",
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_PLACEMENT_AMBIGUOUS" });
  });

  it("produces byte-identical manifests across two runs with the same inputs", async () => {
    const sourcesA = tmpDir();
    const sourcesB = tmpDir();
    const bundleA = await buildSampleBundle(tmpDir(), sourcesA);
    const bundleB = await buildSampleBundle(tmpDir(), sourcesB);
    const resultA = await bundleA.finalize();
    const resultB = await bundleB.finalize();
    const bytesA = fs.readFileSync(resultA.manifestPath);
    const bytesB = fs.readFileSync(resultB.manifestPath);
    expect(bytesA.equals(bytesB)).toBe(true);
    expect(resultA.manifestSha256).toBe(resultB.manifestSha256);
    expect(
      fs
        .readFileSync(resultA.metaPath)
        .equals(fs.readFileSync(resultB.metaPath)),
    ).toBe(true);
  });

  it("hardlinks on the same volume in auto mode", async () => {
    const sources = tmpDir();
    const bundle = createBundle({
      rootDir: tmpDir(),
      provenance: PROVENANCE,
      now: fixedClock(),
    });
    const sourcePath = writeFixture(sources, "video.mp4", "mp4-bytes");
    const entry = await bundle.addArtifact(sourcePath, {
      kind: "video",
      source: "e2e-recordings",
      producedBy: "run-all.mjs",
    });
    const stored = path.join(bundle.dir, ...entry.path.split("/"));
    expect(fs.statSync(stored).ino).toBe(fs.statSync(sourcePath).ino);
  });

  it("copies when linkMode is copy", async () => {
    const sources = tmpDir();
    const bundle = createBundle({
      rootDir: tmpDir(),
      provenance: PROVENANCE,
      now: fixedClock(),
      linkMode: "copy",
    });
    const sourcePath = writeFixture(sources, "video.mp4", "mp4-bytes");
    const entry = await bundle.addArtifact(sourcePath, {
      kind: "video",
      source: "e2e-recordings",
      producedBy: "run-all.mjs",
    });
    const stored = path.join(bundle.dir, ...entry.path.split("/"));
    expect(fs.statSync(stored).ino).not.toBe(fs.statSync(sourcePath).ino);
    expect(fs.readFileSync(stored, "utf8")).toBe("mp4-bytes");
  });

  it("falls back to copy when the link fails with EXDEV", async () => {
    const sources = tmpDir();
    const exdev = Object.assign(new Error("cross-device link"), {
      code: "EXDEV",
    });
    const bundle = new EvidenceBundle({
      rootDir: tmpDir(),
      provenance: PROVENANCE,
      now: fixedClock(),
      link: () => {
        throw exdev;
      },
    });
    const sourcePath = writeFixture(sources, "video.mp4", "mp4-bytes");
    const entry = await bundle.addArtifact(sourcePath, {
      kind: "video",
      source: "e2e-recordings",
      producedBy: "run-all.mjs",
    });
    const stored = path.join(bundle.dir, ...entry.path.split("/"));
    expect(fs.statSync(stored).ino).not.toBe(fs.statSync(sourcePath).ino);
    expect(fs.readFileSync(stored, "utf8")).toBe("mp4-bytes");
  });

  it("rethrows non-EXDEV link failures", async () => {
    const sources = tmpDir();
    const eperm = Object.assign(new Error("operation not permitted"), {
      code: "EPERM",
    });
    const bundle = new EvidenceBundle({
      rootDir: tmpDir(),
      provenance: PROVENANCE,
      now: fixedClock(),
      link: () => {
        throw eperm;
      },
    });
    await expect(
      bundle.addArtifact(writeFixture(sources, "x.png", "x"), {
        kind: "screenshot",
        source: "s",
        producedBy: "p",
      }),
    ).rejects.toBe(eperm);
  });

  it("throws typed errors for missing sources, collisions, and traversal", async () => {
    const sources = tmpDir();
    const bundle = createBundle({
      rootDir: tmpDir(),
      provenance: PROVENANCE,
      now: fixedClock(),
    });
    await expect(
      bundle.addArtifact(path.join(sources, "nope.png"), {
        kind: "screenshot",
        source: "s",
        producedBy: "p",
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_MISSING" });

    const filePath = writeFixture(sources, "a.png", "a");
    await bundle.addArtifact(filePath, {
      kind: "screenshot",
      source: "s",
      producedBy: "p",
    });
    await expect(
      bundle.addArtifact(filePath, {
        kind: "screenshot",
        source: "s",
        producedBy: "p",
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_PATH_COLLISION" });

    await expect(
      bundle.addArtifact(filePath, {
        kind: "screenshot",
        source: "s",
        producedBy: "p",
        relativePath: "../escape.png",
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_PATH_INVALID" });
  });

  it("is single-use: refuses adds and finalize after finalize", async () => {
    const bundle = await buildSampleBundle(tmpDir(), tmpDir());
    await bundle.finalize();
    await expect(
      bundle.addArtifact(writeFixture(tmpDir(), "late.png", "late"), {
        kind: "screenshot",
        source: "s",
        producedBy: "p",
      }),
    ).rejects.toMatchObject({ code: "BUNDLE_FINALIZED" });
    await expect(bundle.finalize()).rejects.toMatchObject({
      code: "BUNDLE_FINALIZED",
    });
  });

  it("refuses to reuse an existing run dir", async () => {
    const root = tmpDir();
    const options = {
      rootDir: root,
      provenance: PROVENANCE,
      now: fixedClock(),
      runId: "fixed-run-id",
    };
    createBundle(options);
    expect(() => createBundle(options)).toThrow(EvidenceError);
  });
});

describe("verifyBundle", () => {
  it("passes a pristine bundle and reports the stored manifest sha", async () => {
    const bundle = await buildSampleBundle(tmpDir(), tmpDir());
    const finalized = await bundle.finalize();
    const report = await verifyBundle(bundle.dir);
    expect(report.ok).toBe(true);
    expect(report.artifactCount).toBe(3);
    expect(report.verifiedCount).toBe(3);
    expect(report.issues).toEqual([]);
    expect(report.manifestSha256).toBe(finalized.manifestSha256);
  });

  it("catches a tampered file, a deleted file, and an unlisted file", async () => {
    const bundle = await buildSampleBundle(tmpDir(), tmpDir());
    await bundle.finalize();
    // Tamper preserving size so the hash check itself is exercised.
    const tampered = path.join(
      bundle.dir,
      "lanes",
      "e2e",
      "logs",
      "server.log",
    );
    fs.writeFileSync(tampered, "LOG LINE\n");
    fs.rmSync(
      path.join(bundle.dir, "visual", "aesthetic-audit", "desktop", "shot.png"),
    );
    fs.writeFileSync(path.join(bundle.dir, "stray.txt"), "not in manifest");

    const report = await verifyBundle(bundle.dir);
    expect(report.ok).toBe(false);
    expect(report.verifiedCount).toBe(1);
    const byIssue = Object.fromEntries(
      report.issues.map((issue) => [issue.issue, issue.path]),
    );
    expect(byIssue["hash-mismatch"]).toBe("lanes/e2e/logs/server.log");
    expect(byIssue.missing).toBe("visual/aesthetic-audit/desktop/shot.png");
    expect(byIssue.unlisted).toBe("stray.txt");
  });

  it("reports size-mismatch when the stored byte count changed", async () => {
    const bundle = await buildSampleBundle(tmpDir(), tmpDir());
    await bundle.finalize();
    const target = path.join(bundle.dir, "lanes", "e2e", "logs", "server.log");
    fs.appendFileSync(target, "extra");
    const report = await verifyBundle(bundle.dir);
    expect(
      report.issues.some(
        (issue) =>
          issue.issue === "size-mismatch" &&
          issue.path === "lanes/e2e/logs/server.log",
      ),
    ).toBe(true);
  });

  it("throws typed errors for a missing or malformed manifest", async () => {
    const empty = tmpDir();
    await expect(verifyBundle(empty)).rejects.toMatchObject({
      code: "MANIFEST_UNREADABLE",
    });

    fs.writeFileSync(path.join(empty, "manifest.json"), "not json{");
    await expect(verifyBundle(empty)).rejects.toMatchObject({
      code: "MANIFEST_INVALID",
    });

    fs.writeFileSync(
      path.join(empty, "manifest.json"),
      JSON.stringify({ schema: 1, runId: "", createdAt: "x", artifacts: [] }),
    );
    await expect(verifyBundle(empty)).rejects.toBeInstanceOf(
      EvidenceValidationError,
    );
  });
});
