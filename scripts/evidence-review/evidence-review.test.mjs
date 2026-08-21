/**
 * Deterministic evidence-review contract tests using real temporary bundles,
 * the real verifier subprocess, and local screenshot-analysis fixtures.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertSafeOutputDir,
  copyReviewerArtifact,
  parseArgs,
  resolveDefaultBundleDir,
  writeReviewerFile,
} from "./generate.mjs";
import { analyzeImageFile, classifyArtifactPath, inferSource } from "./lib.mjs";

const WHITE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQI12P4////fwAJ+wP90YOM8AAAAABJRU5ErkJggg==",
  "base64",
);

const REPO_ROOT = path.resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
);
const GENERATE = "scripts/evidence-review/generate.mjs";

/** Write a minimal schema-1 evidence bundle with a screenshot and a log. */
async function writeBundle(
  dir,
  { runId = "bundle-run-001", extraReports = 0 } = {},
) {
  await mkdir(path.join(dir, "screens"), { recursive: true });
  await writeFile(path.join(dir, "screens", "a.png"), WHITE_PIXEL_PNG);
  await writeFile(
    path.join(dir, "notes.log"),
    "hello from the bundle\nsecond\n",
  );
  await writeFile(path.join(dir, "sound.wav"), "wave-bytes");
  const now = new Date().toISOString();
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const entry = (p, kind, bytes, hash) => ({
    path: p,
    sha256: hash,
    bytes,
    kind,
    source: "unit-audit",
    producedBy: "evidence-review.test",
    createdAt: now,
  });
  const metaBytes = Buffer.from(
    `${JSON.stringify({
      schema: 1,
      runId,
      commit: "abcdef0123456789abcdef0123456789abcdef01",
      branch: "fix/evidence-review-test",
      runner: "local",
      tier: "cpu",
      startedAt: now,
      finishedAt: now,
      envFingerprint: { node: process.version },
    })}\n`,
  );
  await writeFile(path.join(dir, "meta.json"), metaBytes);
  const artifacts = [
    entry(
      "screens/a.png",
      "screenshot",
      WHITE_PIXEL_PNG.length,
      sha256(WHITE_PIXEL_PNG),
    ),
    entry("notes.log", "log", 29, sha256("hello from the bundle\nsecond\n")),
    entry("sound.wav", "other", 10, sha256("wave-bytes")),
  ];
  for (let index = 0; index < extraReports; index += 1) {
    const rel = `reports/${String(index).padStart(3, "0")}.json`;
    const bytes = Buffer.from(`{"index":${index}}\n`);
    await mkdir(path.join(dir, "reports"), { recursive: true });
    await writeFile(path.join(dir, rel), bytes);
    artifacts.push(entry(rel, "report", bytes.length, sha256(bytes)));
  }
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        schema: 1,
        runId,
        createdAt: now,
        metaSha256: sha256(metaBytes),
        artifacts,
      },
      null,
      2,
    ),
  );
}

/** Run the reviewer CLI under node from the repo root. */
function runGenerate(args) {
  return spawnSync("node", [GENERATE, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

test("classifies supported evidence artifact types", () => {
  assert.equal(classifyArtifactPath("shot.png"), "image");
  assert.equal(classifyArtifactPath("walkthrough.mp4"), "video");
  assert.equal(classifyArtifactPath("server.log"), "log");
  assert.equal(classifyArtifactPath("trajectory.jsonl"), "trajectory");
  assert.equal(classifyArtifactPath("report.json"), "report");
  assert.equal(classifyArtifactPath("index.html"), "viewer");
  assert.equal(classifyArtifactPath("trace.zip"), "archive");
  assert.equal(classifyArtifactPath("archive.bin"), null);
});

test("infers the standard evidence source directories", () => {
  const root = "/repo";
  assert.equal(
    inferSource(root, "/repo/packages/app/aesthetic-audit-output/report.json"),
    "app-audit",
  );
  assert.equal(
    inferSource(root, "/repo/e2e-recordings/app/test-results/x/trace.zip"),
    "e2e-recordings",
  );
  assert.equal(
    inferSource(root, "/repo/reports/live-test-runs/run/trajectory.jsonl"),
    "live-test-runs",
  );
  assert.equal(
    inferSource(root, "/repo/device-e2e-output/android/run.json"),
    "device-e2e",
  );
  assert.equal(
    inferSource(root, "/repo/packages/app/reports/walkthrough/run/steps.json"),
    "walkthrough",
  );
  assert.equal(
    inferSource(root, "/repo/packages/scenario-runner/reports/run.jsonl"),
    "scenario-runner",
  );
  assert.equal(inferSource(root, "/repo/evidence/matrix-run.json"), "evidence");
});

test("reviewer has no implicit raw producer scan list", async () => {
  const source = await readFile(path.join(REPO_ROOT, GENERATE), "utf8");
  assert.doesNotMatch(source, /DEFAULT_SCAN_DIRS/);
  assert.match(source, /options\.scanDirs/);
  assert.match(source, /resolveDefaultBundleDir/);
});

test("flags one-color screenshots and summarizes dominant colors", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "evidence-review-"));
  try {
    const imagePath = path.join(tmpDir, "solid.png");
    await writeFile(imagePath, WHITE_PIXEL_PNG);

    const analysis = await analyzeImageFile(imagePath);
    assert.equal(analysis.width, 1);
    assert.equal(analysis.height, 1);
    assert.equal(analysis.colorBuckets, 1);
    assert.match(analysis.issues.join(" "), /one color/);
    assert.match(analysis.issues.join(" "), /near-solid/);
    assert.equal(analysis.dominantColors[0].hex, "#ffffff");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("--bundle reviews an evidence bundle's manifest without silo scanning", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "evidence-bundle-"));
  try {
    const bundleDir = path.join(tmpDir, "bundle");
    const outDir = path.join(tmpDir, "out");
    await writeBundle(bundleDir);

    const result = runGenerate([
      `--bundle=${bundleDir}`,
      `--out=${outDir}`,
      "--ocr=off",
      "--no-open",
    ]);
    assert.equal(result.status, 0, `generate failed: ${result.stderr}`);

    const manifest = JSON.parse(
      await readFile(path.join(outDir, "manifest.json"), "utf8"),
    );
    // Bare --bundle reviews only the bundle, so no silo dirs were scanned.
    assert.deepEqual(manifest.scanDirs, []);
    assert.equal(manifest.artifacts.length, 3);

    const shot = manifest.artifacts.find((a) => a.type === "image");
    assert.ok(shot, "screenshot artifact present");
    assert.equal(shot.source, "unit-audit");
    assert.equal(shot.bundleRunId, "bundle-run-001");
    // The bundle screenshot ran through the shared image heuristics.
    assert.ok(shot.image && shot.image.dominantColors.length > 0);

    const log = manifest.artifacts.find((a) => a.type === "log");
    assert.ok(log, "log artifact present");
    assert.match(log.preview, /hello from the bundle/);
    assert.match(log.href, /^artifacts\//);
    await writeFile(path.join(bundleDir, "notes.log"), "mutated later\n");
    assert.match(
      await readFile(path.resolve(outDir, log.href), "utf8"),
      /hello from the bundle/,
    );
    const other = manifest.artifacts.find((a) => a.type === "artifact");
    assert.ok(other, "schema-listed other artifact remains inspectable");
    assert.equal(other.source, "unit-audit");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("zero-argument bundle resolution selects the newest finalized run", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "evidence-runs-"));
  try {
    const oldBundle = path.join(tmpDir, "old-run");
    const newBundle = path.join(tmpDir, "new-run");
    await writeBundle(oldBundle, { runId: "old-run" });
    await writeBundle(newBundle, { runId: "new-run" });
    await utimes(
      path.join(oldBundle, "manifest.json"),
      new Date(1_000),
      new Date(1_000),
    );
    await utimes(
      path.join(newBundle, "manifest.json"),
      new Date(2_000),
      new Date(2_000),
    );
    assert.equal(resolveDefaultBundleDir(tmpDir), newBundle);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("bundle review never silently truncates a verified manifest", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "evidence-complete-"));
  try {
    const bundleDir = path.join(tmpDir, "bundle");
    const outDir = path.join(tmpDir, "out");
    await writeBundle(bundleDir, { extraReports: 901 });
    const result = runGenerate([
      `--bundle=${bundleDir}`,
      `--out=${outDir}`,
      "--ocr=off",
      "--no-open",
      "--max-artifacts=100",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const review = JSON.parse(
      await readFile(path.join(outDir, "manifest.json"), "utf8"),
    );
    assert.equal(review.artifacts.length, 904);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("rejects reviewer output that could mutate the verified bundle", () => {
  const bundle = path.resolve("/tmp/evidence-bundle");
  assert.throws(() => assertSafeOutputDir(bundle, bundle), /must not overlap/);
  assert.throws(
    () => assertSafeOutputDir(path.join(bundle, "review"), bundle),
    /must not overlap/,
  );
  assert.throws(
    () => assertSafeOutputDir(path.dirname(bundle), bundle),
    /must not overlap/,
  );
  assert.doesNotThrow(() =>
    assertSafeOutputDir(path.resolve("/tmp/evidence-review"), bundle),
  );
});

test("rejects reviewer output that overlaps an explicit compatibility source", () => {
  const source = path.resolve("/tmp/evidence-source");
  assert.throws(
    () => assertSafeOutputDir(source, null, [source]),
    /evidence source directories must not overlap/,
  );
  assert.throws(
    () => assertSafeOutputDir(path.join(source, "review"), null, [source]),
    /evidence source directories must not overlap/,
  );
  assert.throws(
    () => assertSafeOutputDir(path.dirname(source), null, [source]),
    /evidence source directories must not overlap/,
  );
});

test("rejects a reviewer output symlink into the verified bundle", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "evidence-overlap-"));
  try {
    const bundle = path.join(tmpDir, "bundle");
    await mkdir(bundle);
    const linkedOutput = path.join(tmpDir, "linked-output");
    await symlink(bundle, linkedOutput, "dir");
    assert.throws(
      () => assertSafeOutputDir(linkedOutput, bundle),
      /must not be a symlink/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("rejects a reviewer output symlink before cleanup can escape", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "evidence-output-link-"));
  try {
    const external = path.join(tmpDir, "external");
    const linkedOutput = path.join(tmpDir, "linked-output");
    await mkdir(external);
    await symlink(external, linkedOutput, "dir");
    assert.throws(
      () => assertSafeOutputDir(linkedOutput, null),
      /must not be a symlink/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("reviewer leaf writes replace symlink and hardlink aliases without mutating their targets", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "evidence-output-leaf-"));
  try {
    const external = path.join(tmpDir, "external.json");
    const symlinkLeaf = path.join(tmpDir, "manifest.json");
    const hardlinkLeaf = path.join(tmpDir, "index.html");
    await writeFile(external, "protected");
    await symlink(external, symlinkLeaf);
    await link(external, hardlinkLeaf);

    writeReviewerFile(symlinkLeaf, "review manifest");
    writeReviewerFile(hardlinkLeaf, "review index");

    assert.equal(await readFile(external, "utf8"), "protected");
    assert.equal(await readFile(symlinkLeaf, "utf8"), "review manifest");
    assert.equal(await readFile(hardlinkLeaf, "utf8"), "review index");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("reviewer snapshots raw compatibility inputs into private leaves", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "evidence-source-copy-"));
  try {
    const source = path.join(tmpDir, "live.log");
    const owned = path.join(tmpDir, "review", "artifacts", "live.log");
    await writeFile(source, "reviewed bytes");
    copyReviewerArtifact(source, owned);
    await writeFile(source, "changed after review");
    assert.equal(await readFile(owned, "utf8"), "reviewed bytes");
    assert.notEqual((await stat(source)).ino, (await stat(owned)).ino);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("--bundle rejects artifact bytes that do not match the manifest", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "evidence-tamper-"));
  try {
    const bundleDir = path.join(tmpDir, "bundle");
    await writeBundle(bundleDir);
    await writeFile(path.join(bundleDir, "notes.log"), "tampered\n");
    const result = runGenerate([
      `--bundle=${bundleDir}`,
      `--out=${path.join(tmpDir, "out")}`,
      "--ocr=off",
      "--no-open",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /integrity verification failed/);
    assert.match(result.stderr, /notes\.log/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("--bundle fails fast when a manifest lists a missing file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "evidence-bundle-"));
  try {
    const bundleDir = path.join(tmpDir, "bundle");
    await mkdir(bundleDir, { recursive: true });
    const now = new Date().toISOString();
    const meta = `${JSON.stringify({
      schema: 1,
      runId: "broken",
      commit: "abcdef0123456789abcdef0123456789abcdef01",
      branch: "fix/test",
      runner: "local",
      tier: "cpu",
      startedAt: now,
      envFingerprint: { node: process.version },
    })}\n`;
    await writeFile(path.join(bundleDir, "meta.json"), meta);
    await writeFile(
      path.join(bundleDir, "manifest.json"),
      JSON.stringify({
        schema: 1,
        runId: "broken",
        createdAt: now,
        metaSha256: createHash("sha256").update(meta).digest("hex"),
        artifacts: [
          {
            path: "screens/missing.png",
            sha256: "0".repeat(64),
            bytes: 1,
            kind: "screenshot",
            source: "unit-audit",
            producedBy: "test",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );

    const result = runGenerate([
      `--bundle=${bundleDir}`,
      `--out=${path.join(tmpDir, "out")}`,
      "--ocr=off",
      "--no-open",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing: screens\/missing\.png/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("rejects malformed numeric limits before creating output", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "evidence-review-args-"));
  try {
    const invalidArguments = [
      "--max-images=1junk",
      "--max-images=1.5",
      "--max-images=-1",
      "--max-images=+1",
      "--max-images=01",
      "--max-images=",
      "--max-images= ",
      "--max-images=9007199254740992",
      "--max-artifacts=99",
      "--max-artifacts=100oops",
      "--max-files-per-dir=99",
      "--max-files-per-dir=100.5",
    ];

    for (const argument of invalidArguments) {
      assert.throws(
        () => parseArgs([argument]),
        /must be|requires a non-empty value/,
        argument,
      );
    }

    const outDir = path.join(tmpDir, "out");
    const result = runGenerate([
      `--out=${outDir}`,
      "--source=/definitely/missing",
      "--ocr=off",
      "--no-open",
      "--max-artifacts=99",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be/);
    await assert.rejects(() => stat(outDir));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("rejects empty path options during argument parsing", () => {
  for (const argument of [
    "--out=",
    "--out= ",
    "--source=",
    "--source= ",
    "--bundle=",
    "--bundle= ",
  ]) {
    assert.throws(
      () => parseArgs([argument]),
      /requires a non-empty value/,
      argument,
    );
  }
});

test("preserves valid numeric boundary values", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "evidence-review-args-"));
  try {
    const parsed = parseArgs([
      "--max-images=0",
      "--max-artifacts=100",
      "--max-files-per-dir=100",
    ]);
    assert.equal(parsed.maxImages, 0);
    assert.equal(parsed.maxArtifacts, 100);
    assert.equal(parsed.maxFilesPerDir, 100);

    const outDir = path.join(tmpDir, "out");
    const result = runGenerate([
      `--out=${outDir}`,
      "--source=/definitely/missing",
      "--ocr=off",
      "--no-open",
      "--max-images=0",
      "--max-artifacts=100",
      "--max-files-per-dir=100",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(
      await readFile(path.join(outDir, "manifest.json"), "utf8"),
    );
    assert.deepEqual(manifest.artifacts, []);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
