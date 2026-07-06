/**
 * Unit tests for the evidence-review classifier and screenshot heuristics.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeImageFile, classifyArtifactPath, inferSource } from "./lib.mjs";

const WHITE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
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
async function writeBundle(dir, { runId = "bundle-run-001" } = {}) {
  await mkdir(path.join(dir, "screens"), { recursive: true });
  await writeFile(path.join(dir, "screens", "a.png"), WHITE_PIXEL_PNG);
  await writeFile(
    path.join(dir, "notes.log"),
    "hello from the bundle\nsecond\n",
  );
  const now = new Date().toISOString();
  const entry = (p, kind, bytes) => ({
    path: p,
    sha256: "0".repeat(64),
    bytes,
    kind,
    source: "unit-audit",
    producedBy: "evidence-review.test",
    createdAt: now,
  });
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        schema: 1,
        runId,
        createdAt: now,
        metaSha256: "0".repeat(64),
        artifacts: [
          entry("screens/a.png", "screenshot", WHITE_PIXEL_PNG.length),
          entry("notes.log", "log", 28),
        ],
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
    assert.equal(manifest.artifacts.length, 2);

    const shot = manifest.artifacts.find((a) => a.type === "image");
    assert.ok(shot, "screenshot artifact present");
    assert.equal(shot.source, "unit-audit");
    assert.equal(shot.bundleRunId, "bundle-run-001");
    // The bundle screenshot ran through the shared image heuristics.
    assert.ok(shot.image && shot.image.dominantColors.length > 0);

    const log = manifest.artifacts.find((a) => a.type === "log");
    assert.ok(log, "log artifact present");
    assert.match(log.preview, /hello from the bundle/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("--bundle fails fast when a manifest lists a missing file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "evidence-bundle-"));
  try {
    const bundleDir = path.join(tmpDir, "bundle");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      path.join(bundleDir, "manifest.json"),
      JSON.stringify({
        schema: 1,
        runId: "broken",
        createdAt: new Date().toISOString(),
        metaSha256: "0".repeat(64),
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
    assert.match(result.stderr, /missing from the bundle/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
