import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildReport,
  resolveVisionArtifact,
  writeReport,
} from "./eliza1_vision_smoke.mjs";

const SHA = "0".repeat(64);

function argsFor(bundleDir, overrides = {}) {
  return {
    bundleDir,
    tier: "",
    image: "",
    mtmdCli: join(bundleDir, "missing-llama-mtmd-cli"),
    ctxSize: 2048,
    batchSize: 2048,
    nPredict: 8,
    gpuLayers: "",
    timeoutMs: 1_000,
    outs: [],
    ...overrides,
  };
}

function writeBundle(
  tier,
  {
    manifestVision = true,
    lineageVision = manifestVision,
    bundleVision = manifestVision,
    asrMmproj = false,
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), `eliza1-vision-${tier}-`));
  mkdirSync(join(dir, "text"), { recursive: true });
  mkdirSync(join(dir, "asr"), { recursive: true });
  mkdirSync(join(dir, "vision"), { recursive: true });
  writeFileSync(join(dir, "text", `eliza-1-${tier}.gguf`), "text-model");
  if (asrMmproj) {
    writeFileSync(join(dir, "asr", "eliza-1-asr-mmproj.gguf"), "asr-mmproj");
  }
  if (bundleVision) {
    writeFileSync(join(dir, "vision", `mmproj-${tier}.gguf`), "vision-mmproj");
  }

  const manifest = {
    id: `eliza-1-${tier}`,
    tier,
    version: "1.0.0",
    publishedAt: "2026-05-15T00:00:00Z",
    lineage: {
      text: { base: "eliza-1-text", license: "apache-2.0" },
      voice: { base: "eliza-1-voice", license: "apache-2.0" },
      ...(lineageVision
        ? { vision: { base: "eliza-1-vision", license: "apache-2.0" } }
        : {}),
    },
    files: {
      text: [{ path: `text/eliza-1-${tier}.gguf`, ctx: 32768, sha256: SHA }],
      voice: [{ path: "tts/kokoro/model_q4.onnx", sha256: SHA }],
      asr: [{ path: "asr/eliza-1-asr.gguf", sha256: SHA }],
      vision: manifestVision
        ? [{ path: `vision/mmproj-${tier}.gguf`, sha256: SHA }]
        : [],
      dflash: [],
      cache: [{ path: "cache/voice-preset-default.bin", sha256: SHA }],
    },
    kernels: {
      required: ["turboquant_q4", "qjl", "polarquant"],
      optional: [],
      verifiedBackends: {
        metal: { status: "pass", atCommit: "abc1234", report: "metal.txt" },
        vulkan: { status: "pass", atCommit: "abc1234", report: "vulkan.txt" },
        cuda: { status: "pass", atCommit: "abc1234", report: "cuda.txt" },
        rocm: { status: "pass", atCommit: "abc1234", report: "rocm.txt" },
        cpu: { status: "pass", atCommit: "abc1234", report: "cpu.txt" },
      },
    },
    evals: {
      textEval: { score: 0.7, passed: true },
      voiceRtf: { rtf: 0.5, passed: true },
      e2eLoopOk: true,
      thirtyTurnOk: true,
    },
    ramBudgetMb: { min: 1000, recommended: 2000 },
    defaultEligible: false,
  };
  writeFileSync(
    join(dir, "eliza-1.manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return dir;
}

test("resolves tier-compatible bundle mmproj artifacts from the vision directory", () => {
  const dir = writeBundle("4b", {
    manifestVision: false,
    lineageVision: false,
    bundleVision: true,
  });
  try {
    const resolved = resolveVisionArtifact(dir, "4b", []);
    assert.equal(resolved.selected?.relPath, "vision/mmproj-4b.gguf");
    assert.equal(resolved.selected?.source, "bundle.vision");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("0_8B and 2B require image-analysis vision artifacts; ASR mmproj is not enough", () => {
  for (const tier of ["0_8b", "2b"]) {
    const dir = writeBundle(tier, {
      manifestVision: false,
      lineageVision: false,
      bundleVision: false,
      asrMmproj: true,
    });
    try {
      const report = buildReport(argsFor(dir));
      assert.equal(report.expectedVisionTier, true);
      assert.equal(report.status, "fail");
      assert.equal(report.evidence.result, "fail");
      assert.deepEqual(report.evidence.blockers, ["manifest-files-vision-empty"]);
      assert.equal(report.inventory.asrMmprojFiles.length, 1);
      assert.equal(report.inventory.visionMmprojCandidates.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("0_8B and 2B accept tier-compatible image-analysis vision artifacts", () => {
  for (const tier of ["0_8b", "2b"]) {
    const dir = writeBundle(tier, {
      manifestVision: true,
      lineageVision: true,
      bundleVision: true,
    });
    try {
      const report = buildReport(argsFor(dir));
      assert.equal(report.status, "fail");
      assert.equal(report.evidence.result, "fail");
      assert.equal(report.mmproj.relPath, `vision/mmproj-${tier}.gguf`);
      assert.equal(report.imageAnalysis.status, "not-run");
      assert.deepEqual(report.evidence.blockers, ["vision-smoke-not-passed"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("active vision tiers write fail evidence until image smoke passes", () => {
  for (const tier of ["0_8b", "2b", "4b", "9b", "27b", "27b-256k"]) {
    const dir = writeBundle(tier);
    try {
      const report = buildReport(argsFor(dir));
      assert.equal(report.expectedVisionTier, true);
      assert.equal(report.status, "fail");
      assert.equal(report.evidence.result, "fail");
      assert.equal(report.evidence.passRecordable, false);
      assert.equal(report.mmproj.relPath, `vision/mmproj-${tier}.gguf`);
      assert.equal(report.imageAnalysis.status, "not-run");

      const out = join(dir, "evidence", "vision-smoke.json");
      const written = writeReport(report, [out]);
      assert.deepEqual(written, [out]);
      const parsed = JSON.parse(readFileSync(out, "utf8"));
      assert.equal(parsed.evidence.result, "fail");
      assert.equal(parsed.mmproj.relPath, `vision/mmproj-${tier}.gguf`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
