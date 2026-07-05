/**
 * Unit tests for the evidence-review classifier and screenshot heuristics.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { analyzeImageFile, classifyArtifactPath, inferSource } from "./lib.mjs";

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
    const png = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: "#ffffff",
      },
    })
      .png()
      .toBuffer();
    await writeFile(imagePath, png);

    const analysis = await analyzeImageFile(imagePath, sharp);
    assert.equal(analysis.width, 64);
    assert.equal(analysis.height, 64);
    assert.equal(analysis.colorBuckets, 1);
    assert.match(analysis.issues.join(" "), /one color/);
    assert.match(analysis.issues.join(" "), /near-solid/);
    assert.equal(analysis.dominantColors[0].hex, "#ffffff");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
