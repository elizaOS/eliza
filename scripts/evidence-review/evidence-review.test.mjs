/**
 * Unit tests for the evidence-review classifier and screenshot heuristics.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./generate.mjs";
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

    for (const [index, argument] of invalidArguments.entries()) {
      const outDir = path.join(tmpDir, `out-${index}`);
      const result = runGenerate([
        `--out=${outDir}`,
        "--source=/definitely/missing",
        "--ocr=off",
        "--no-open",
        argument,
      ]);

      assert.notEqual(result.status, 0, argument);
      assert.match(result.stderr, /must be|requires a non-empty value/);
      await assert.rejects(() => stat(outDir));
    }
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
