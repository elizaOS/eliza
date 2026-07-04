/**
 * Verifies the eval-comparison artifact payload builder against fixed
 * base/candidate inputs on a temp filesystem (deterministic).
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEvalComparisonArtifactPayload,
  buildLocalEvalComparisonArgs,
  EVAL_COMPARISON_ARTIFACT_SCHEMA,
  runLocalEvalComparison,
  writeEvalComparisonArtifact,
} from "./eval-comparison-artifact.js";

const comparisonReport = {
  timestamp: "2026-05-23T10:00:00.000Z",
  backend: "cpu",
  base_model: {
    label: "base",
    model_ref: "eliza-1-0b-base",
    summary: {
      prompt_count: 10,
      avg_score: 0.4,
      avg_latency_ms: 120,
      format_rate: 0.7,
    },
  },
  trained_model: {
    label: "trained",
    model_ref: "/models/eliza-1-0b-trained",
    summary: {
      prompt_count: 10,
      avg_score: 0.6,
      avg_latency_ms: 140,
      format_rate: 0.9,
    },
  },
  comparison: {
    distinct_response_count: 8,
    per_prompt: [],
  },
};

describe("eval comparison artifacts", () => {
  it("normalizes base-vs-trained comparison metrics", () => {
    const artifact = buildEvalComparisonArtifactPayload({
      report: comparisonReport,
      reportPath: "/tmp/local_model_comparison.json",
    });

    expect(artifact.schema).toBe(EVAL_COMPARISON_ARTIFACT_SCHEMA);
    expect(artifact.models).toEqual({
      base: "eliza-1-0b-base",
      trained: "/models/eliza-1-0b-trained",
      backend: "cpu",
    });
    expect(artifact.metrics).toMatchObject({
      baseScore: 0.4,
      trainedScore: 0.6,
      improvementAbsolute: 0.2,
      improvementPercent: 50,
      baseLatencyMs: 120,
      trainedLatencyMs: 140,
      latencyDeltaMs: 20,
      promptCount: 10,
      distinctResponseCount: 8,
    });
  });

  it("writes an indexable eval comparison artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-comparison-"));
    const reportPath = join(root, "local_model_comparison.json");
    await writeFile(reportPath, JSON.stringify(comparisonReport), "utf-8");

    const result = await writeEvalComparisonArtifact({
      report: comparisonReport,
      reportPath,
      outputDir: root,
      source: { kind: "test" },
    });

    expect(result.artifactPath).toBe(join(root, "eval-comparison.json"));
    const onDisk = JSON.parse(await readFile(result.artifactPath, "utf-8"));
    expect(onDisk.schema).toBe(EVAL_COMPARISON_ARTIFACT_SCHEMA);
    expect(onDisk.metrics.improvementPercent).toBe(50);
    expect(onDisk.source.kind).toBe("test");
  });

  it("builds local eval comparison command args", () => {
    expect(
      buildLocalEvalComparisonArgs(
        {
          model: "eliza-1-0b-base",
          trainedModelPath: "/models/eliza-1-0b-trained",
          backend: "cpu",
          promptFile: "/tmp/prompts.jsonl",
          maxTokens: 32,
        },
        {
          trainingRoot: "/repo/packages/training",
          reportPath: "/tmp/eval/local_model_comparison.json",
        },
      ),
    ).toEqual([
      "/repo/packages/training/scripts/rl/compare_local_models.py",
      "--model",
      "eliza-1-0b-base",
      "--trained-model-path",
      "/models/eliza-1-0b-trained",
      "--backend",
      "cpu",
      "--prompt-file",
      "/tmp/prompts.jsonl",
      "--max-tokens",
      "32",
      "--output",
      "/tmp/eval/local_model_comparison.json",
    ]);
  });

  it("supports dry-run local eval comparison artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-comparison-dry-run-"));
    const result = await runLocalEvalComparison({
      outputDir: root,
      model: "eliza-1-0b-base",
      trainedModelPath: "/models/eliza-1-0b-trained",
      backend: "cpu",
      dryRun: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.command).toEqual(
      expect.arrayContaining([
        "python3",
        "--model",
        "eliza-1-0b-base",
        "--trained-model-path",
        "/models/eliza-1-0b-trained",
      ]),
    );
    expect(result.artifact.source).toMatchObject({
      kind: "training_local_eval_comparison",
      dryRun: true,
    });
    expect(result.artifactPath).toBe(join(root, "eval-comparison.json"));
  });
});
