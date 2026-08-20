/**
 * Real-filesystem tests for the bundle builder and verifier: byte-stable
 * manifests under an injected clock, copy materialization, path
 * collision/traversal refusal, single-use lifecycle, and tamper detection.
 * Everything runs against real files in temporary directories.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BundleProvenance } from "./bundle.ts";
import {
  assertSafeCertificationOutput,
  createBundle,
  formatRunId,
  verifyBundle,
  writeOwnedFileAtomic,
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

describe("bundle run directory ownership", () => {
  it.each(["../escape", "nested/run", "nested\\run", ".", ".."])(
    "rejects an unsafe custom run id %s before creating outside the root",
    (runId) => {
      const parent = tmpDir();
      const root = path.join(parent, "runs");
      expect(() =>
        createBundle({
          rootDir: root,
          runId,
          provenance: PROVENANCE,
          now: fixedClock(),
        }),
      ).toThrow(expect.objectContaining({ code: "BUNDLE_RUN_ID_INVALID" }));
      expect(fs.existsSync(path.join(parent, "escape"))).toBe(false);
    },
  );

  it("does not follow a pre-existing run-directory symlink", () => {
    const root = tmpDir();
    const external = tmpDir();
    fs.symlinkSync(external, path.join(root, "claimed"), "dir");
    expect(() =>
      createBundle({
        rootDir: root,
        runId: "claimed",
        provenance: PROVENANCE,
        now: fixedClock(),
      }),
    ).toThrow(expect.objectContaining({ code: "BUNDLE_DIR_EXISTS" }));
    expect(fs.readdirSync(external)).toEqual([]);
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

  it("NFC-normalizes bundle paths so NFD input cannot drift manifest bytes", async () => {
    const sources = tmpDir();
    const bundle = createBundle({
      rootDir: tmpDir(),
      provenance: PROVENANCE,
      now: fixedClock(),
    });
    // "caf\u00e9.png" in decomposed NFD form (e + combining acute), the way
    // macOS reports filenames; the manifest must carry the precomposed NFC.
    const nfdName = "cafe\u0301.png";
    const nfcName = "caf\u00e9.png";
    expect(nfdName).not.toBe(nfcName);
    const entry = await bundle.addArtifact(
      writeFixture(sources, "shot.png", "png"),
      {
        kind: "screenshot",
        source: "s",
        producedBy: "p",
        relativePath: nfdName,
      },
    );
    expect(entry.path).toBe(`visual/s/${nfcName}`);
    const { manifest } = await bundle.finalize();
    expect(manifest.artifacts[0].path).toBe(`visual/s/${nfcName}`);
  });

  it("binds meta.json into the manifest via metaSha256", async () => {
    const bundle = await buildSampleBundle(tmpDir(), tmpDir());
    const { manifest, metaPath } = await bundle.finalize();
    const metaHash = createHash("sha256")
      .update(fs.readFileSync(metaPath))
      .digest("hex");
    expect(manifest.metaSha256).toBe(metaHash);
  });

  it("does not follow pre-positioned bundle envelope aliases", async () => {
    const externalSymlinkTarget = writeFixture(
      tmpDir(),
      "external-meta.json",
      "protected-meta",
    );
    const symlinkBundle = createBundle({
      rootDir: tmpDir(),
      provenance: PROVENANCE,
      now: fixedClock(),
    });
    fs.symlinkSync(
      externalSymlinkTarget,
      path.join(symlinkBundle.dir, "meta.json"),
    );
    await expect(symlinkBundle.finalize()).rejects.toMatchObject({
      code: "BUNDLE_ENVELOPE_UNSAFE",
    });
    expect(fs.readFileSync(externalSymlinkTarget, "utf8")).toBe(
      "protected-meta",
    );

    const externalHardlinkTarget = writeFixture(
      tmpDir(),
      "external-manifest.json",
      "protected-manifest",
    );
    const hardlinkBundle = createBundle({
      rootDir: tmpDir(),
      provenance: PROVENANCE,
      now: fixedClock(),
    });
    fs.linkSync(
      externalHardlinkTarget,
      path.join(hardlinkBundle.dir, "manifest.json"),
    );
    await expect(hardlinkBundle.finalize()).rejects.toMatchObject({
      code: "BUNDLE_ENVELOPE_UNSAFE",
    });
    expect(fs.readFileSync(externalHardlinkTarget, "utf8")).toBe(
      "protected-manifest",
    );
  });

  it.each(["manifest.json", "meta.json", "certification.json"])(
    "reserves the bundle envelope path %s",
    async (bundlePath) => {
      const bundle = createBundle({
        rootDir: tmpDir(),
        provenance: PROVENANCE,
        now: fixedClock(),
      });
      await expect(
        bundle.addArtifact(writeFixture(tmpDir(), "artifact.json", "{}"), {
          kind: "report",
          source: "test",
          producedBy: "test",
          bundlePath,
        }),
      ).rejects.toMatchObject({ code: "ARTIFACT_PATH_RESERVED" });
    },
  );

  it("atomically replaces owned symlink and hardlink leaves", () => {
    const root = tmpDir();
    const external = writeFixture(root, "external.json", "protected");
    const symlinkLeaf = path.join(root, "certification.json");
    const hardlinkLeaf = path.join(root, "review.json");
    fs.symlinkSync(external, symlinkLeaf);
    fs.linkSync(external, hardlinkLeaf);

    writeOwnedFileAtomic(symlinkLeaf, "signed");
    writeOwnedFileAtomic(hardlinkLeaf, "reviewed");

    expect(fs.readFileSync(external, "utf8")).toBe("protected");
    expect(fs.readFileSync(symlinkLeaf, "utf8")).toBe("signed");
    expect(fs.readFileSync(hardlinkLeaf, "utf8")).toBe("reviewed");
    expect(fs.lstatSync(symlinkLeaf).isSymbolicLink()).toBe(false);
    expect(fs.statSync(symlinkLeaf).nlink).toBe(1);
    expect(fs.statSync(hardlinkLeaf).nlink).toBe(1);
  });

  it("reserves every in-bundle leaf except certification.json for signing", () => {
    const bundleDir = tmpDir();
    const alias = path.join(tmpDir(), "bundle-alias");
    fs.symlinkSync(bundleDir, alias, "dir");
    const outside = path.join(tmpDir(), "certification.json");
    const outsideTarget = writeFixture(
      tmpDir(),
      "external-manifest.json",
      "protected",
    );
    const reservedLeafSymlink = path.join(bundleDir, "manifest.json");
    fs.symlinkSync(outsideTarget, reservedLeafSymlink);
    const externalLeafSymlink = path.join(tmpDir(), "external-output.json");
    fs.symlinkSync(path.join(bundleDir, "manifest.json"), externalLeafSymlink);
    expect(() =>
      assertSafeCertificationOutput(
        bundleDir,
        path.join(bundleDir, "certification.json"),
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeCertificationOutput(bundleDir, outside),
    ).not.toThrow();
    expect(() =>
      assertSafeCertificationOutput(bundleDir, externalLeafSymlink),
    ).not.toThrow();
    writeOwnedFileAtomic(externalLeafSymlink, "external certification");
    expect(fs.readFileSync(externalLeafSymlink, "utf8")).toBe(
      "external certification",
    );
    expect(fs.readFileSync(outsideTarget, "utf8")).toBe("protected");
    expect(fs.lstatSync(reservedLeafSymlink).isSymbolicLink()).toBe(true);
    expect(() =>
      assertSafeCertificationOutput(bundleDir, reservedLeafSymlink),
    ).toThrowError(
      expect.objectContaining({ code: "CERTIFICATION_OUTPUT_UNSAFE" }),
    );
    expect(() =>
      assertSafeCertificationOutput(
        bundleDir,
        path.join(alias, "manifest.json"),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "CERTIFICATION_OUTPUT_UNSAFE" }),
    );
    for (const relative of ["manifest.json", "meta.json", "visual/proof.png"]) {
      expect(() =>
        assertSafeCertificationOutput(
          bundleDir,
          path.join(bundleDir, relative),
        ),
      ).toThrowError(
        expect.objectContaining({ code: "CERTIFICATION_OUTPUT_UNSAFE" }),
      );
    }
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

  it("copies by default so later producer writes cannot mutate the bundle", async () => {
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
    expect(fs.statSync(stored).ino).not.toBe(fs.statSync(sourcePath).ino);
    const finalized = await bundle.finalize();
    fs.writeFileSync(sourcePath, "changed-after-finalize");
    expect(fs.readFileSync(stored, "utf8")).toBe("mp4-bytes");
    expect((await verifyBundle(path.dirname(finalized.manifestPath))).ok).toBe(
      true,
    );
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

  it("keeps the legacy auto linkMode source-compatible without creating links", async () => {
    const sources = tmpDir();
    const bundle = createBundle({
      rootDir: tmpDir(),
      provenance: PROVENANCE,
      now: fixedClock(),
      linkMode: "auto",
    });
    const sourcePath = writeFixture(sources, "legacy-auto.log", "copy-only");
    const entry = await bundle.addArtifact(sourcePath, {
      kind: "log",
      source: "test",
      producedBy: "test",
    });
    const stored = path.join(bundle.dir, ...entry.path.split("/"));
    expect(fs.statSync(stored).ino).not.toBe(fs.statSync(sourcePath).ino);
    expect(fs.statSync(stored).nlink).toBe(1);
    expect(fs.readFileSync(stored, "utf8")).toBe("copy-only");
  });

  it("rejects symlink and hardlink sources instead of copying external bytes", async () => {
    const sources = tmpDir();
    const external = writeFixture(tmpDir(), "outside.log", "outside");
    const symlinkPath = path.join(sources, "linked.log");
    const hardlinkPath = path.join(sources, "hardlinked.log");
    fs.symlinkSync(external, symlinkPath);
    fs.linkSync(external, hardlinkPath);
    const bundle = createBundle({
      rootDir: tmpDir(),
      provenance: PROVENANCE,
      now: fixedClock(),
    });
    for (const sourcePath of [symlinkPath, hardlinkPath]) {
      await expect(
        bundle.addArtifact(sourcePath, {
          kind: "log",
          source: "test",
          producedBy: "test",
        }),
      ).rejects.toMatchObject({ code: "ARTIFACT_SOURCE_UNSAFE" });
    }
  });

  it("rejects a source changed through the open descriptor during copy", async () => {
    const sources = tmpDir();
    const sourcePath = writeFixture(sources, "changing.log", "before");
    const bundle = createBundle({
      rootDir: tmpDir(),
      provenance: PROVENANCE,
      now: fixedClock(),
    });
    const originalRead = fs.readSync;
    let changed = false;
    fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
      const count = originalRead(...args);
      if (!changed && count > 0) {
        changed = true;
        fs.writeFileSync(sourcePath, "after!");
      }
      return count;
    }) as typeof fs.readSync;
    try {
      await expect(
        bundle.addArtifact(sourcePath, {
          kind: "log",
          source: "test",
          producedBy: "test",
        }),
      ).rejects.toMatchObject({ code: "ARTIFACT_SOURCE_UNSTABLE" });
      expect(
        fs.existsSync(path.join(bundle.dir, "misc/test/changing.log")),
      ).toBe(false);
    } finally {
      fs.readSync = originalRead;
    }
  });

  it("rejects a bundle destination replaced before the copied bytes are bound", async () => {
    const sources = tmpDir();
    const sourcePath = writeFixture(sources, "destination-race.log", "source");
    const bundle = createBundle({
      rootDir: tmpDir(),
      provenance: PROVENANCE,
      now: fixedClock(),
    });
    const destination = path.join(
      bundle.dir,
      "misc",
      "test",
      "destination-race.log",
    );
    const originalFsync = fs.fsyncSync;
    let replaced = false;
    fs.fsyncSync = ((descriptor: number) => {
      originalFsync(descriptor);
      if (!replaced && fs.existsSync(destination)) {
        replaced = true;
        fs.renameSync(destination, `${destination}.copied`);
        fs.writeFileSync(destination, "forged");
      }
    }) as typeof fs.fsyncSync;
    try {
      await expect(
        bundle.addArtifact(sourcePath, {
          kind: "log",
          source: "test",
          producedBy: "test",
        }),
      ).rejects.toMatchObject({ code: "ARTIFACT_SOURCE_UNSTABLE" });
      expect(replaced).toBe(true);
    } finally {
      fs.fsyncSync = originalFsync;
    }
  });

  it("does not delete a pre-existing destination when exclusive copy fails", async () => {
    const bundle = createBundle({
      rootDir: tmpDir(),
      provenance: PROVENANCE,
      now: fixedClock(),
    });
    const destination = path.join(bundle.dir, "misc/test/existing.log");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, "keep-me");
    await expect(
      bundle.addArtifact(writeFixture(tmpDir(), "existing.log", "new"), {
        kind: "log",
        source: "test",
        producedBy: "test",
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(fs.readFileSync(destination, "utf8")).toBe("keep-me");
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

  it("fails when meta.json provenance is forged (commit flip)", async () => {
    const bundle = await buildSampleBundle(tmpDir(), tmpDir());
    await bundle.finalize();
    const metaPath = path.join(bundle.dir, "meta.json");
    const forged = fs
      .readFileSync(metaPath, "utf8")
      .replace(COMMIT, "f".repeat(40));
    expect(forged).not.toBe(fs.readFileSync(metaPath, "utf8"));
    fs.writeFileSync(metaPath, forged);

    const report = await verifyBundle(bundle.dir);
    expect(report.ok).toBe(false);
    const metaIssue = report.issues.find((i) => i.issue === "meta-mismatch");
    expect(metaIssue).toMatchObject({ path: "meta.json" });
    expect(metaIssue?.expected).toMatch(/^[0-9a-f]{64}$/);
    expect(metaIssue?.actual).toMatch(/^[0-9a-f]{64}$/);
    expect(metaIssue?.actual).not.toBe(metaIssue?.expected);
  });

  it("fails when meta.json is missing", async () => {
    const bundle = await buildSampleBundle(tmpDir(), tmpDir());
    await bundle.finalize();
    fs.rmSync(path.join(bundle.dir, "meta.json"));
    const report = await verifyBundle(bundle.dir);
    expect(report.ok).toBe(false);
    expect(
      report.issues.some(
        (i) => i.issue === "meta-mismatch" && i.actual === "missing",
      ),
    ).toBe(true);
  });

  // The four symlink scenarios the security review proved exploitable when the
  // walk was isFile()/isDirectory()-based and the verify loop followed links.
  it("flags an unlisted file symlink instead of ignoring it", async () => {
    const external = tmpDir();
    const externalFile = path.join(external, "external.txt");
    fs.writeFileSync(externalFile, "outside the bundle");
    const bundle = await buildSampleBundle(tmpDir(), tmpDir());
    await bundle.finalize();
    fs.symlinkSync(externalFile, path.join(bundle.dir, "sneaky-link.txt"));

    const report = await verifyBundle(bundle.dir);
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual({
      path: "sneaky-link.txt",
      issue: "symlink",
    });
  });

  it("flags a directory symlink instead of following it", async () => {
    const external = tmpDir();
    fs.writeFileSync(path.join(external, "mounted.txt"), "external tree");
    const bundle = await buildSampleBundle(tmpDir(), tmpDir());
    await bundle.finalize();
    fs.symlinkSync(external, path.join(bundle.dir, "mounted-dir"));

    const report = await verifyBundle(bundle.dir);
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual({
      path: "mounted-dir",
      issue: "symlink",
    });
    // The external tree behind the link must not be walked.
    expect(report.issues.some((i) => i.path.includes("mounted.txt"))).toBe(
      false,
    );
  });

  it("fails a listed artifact replaced by a symlink to matching external bytes", async () => {
    const bundle = await buildSampleBundle(tmpDir(), tmpDir());
    await bundle.finalize();
    const artifactRel = ["lanes", "e2e", "logs", "server.log"];
    const artifactPath = path.join(bundle.dir, ...artifactRel);
    // Byte-identical external copy: stat-based verification would pass this.
    const external = tmpDir();
    const externalCopy = path.join(external, "server.log");
    fs.copyFileSync(artifactPath, externalCopy);
    fs.rmSync(artifactPath);
    fs.symlinkSync(externalCopy, artifactPath);

    const report = await verifyBundle(bundle.dir);
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual({
      path: "lanes/e2e/logs/server.log",
      issue: "symlink",
    });
    // Flagged exactly once (verify loop), not duplicated by the sweep.
    expect(
      report.issues.filter((i) => i.path === "lanes/e2e/logs/server.log"),
    ).toHaveLength(1);
  });

  it("rejects hardlinked artifacts and envelope files", async () => {
    const sources = tmpDir();
    const bundle = createBundle({
      rootDir: tmpDir(),
      provenance: PROVENANCE,
      now: fixedClock(),
    });
    const entry = await bundle.addArtifact(
      writeFixture(sources, "proof.log", "proof"),
      { kind: "log", source: "test", producedBy: "test" },
    );
    const finalized = await bundle.finalize();
    const artifactPath = path.join(bundle.dir, ...entry.path.split("/"));
    fs.linkSync(artifactPath, path.join(tmpDir(), "artifact-alias.log"));
    fs.linkSync(
      finalized.manifestPath,
      path.join(tmpDir(), "manifest-alias.json"),
    );

    const report = await verifyBundle(bundle.dir);
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual({
      path: entry.path,
      issue: "hardlink",
    });
    expect(report.issues).toContainEqual({
      path: "manifest.json",
      issue: "hardlink",
    });
  });

  it("still reports a plain unlisted regular file as unlisted (control)", async () => {
    const bundle = await buildSampleBundle(tmpDir(), tmpDir());
    await bundle.finalize();
    fs.writeFileSync(path.join(bundle.dir, "plain-stray.txt"), "stray");
    const report = await verifyBundle(bundle.dir);
    expect(report.issues).toContainEqual({
      path: "plain-stray.txt",
      issue: "unlisted",
    });
    expect(report.issues.some((i) => i.issue === "symlink")).toBe(false);
  });
});
