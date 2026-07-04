/**
 * Verifies the benchmark-matrix artifact builder and its schema against fixed
 * per-tier inputs on a temp filesystem (deterministic).
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BENCHMARK_MATRIX_ARTIFACT_SCHEMA,
  buildBenchmarkMatrixArtifactPayload,
  buildBenchmarkMatrixRowsFromArtifactPayload,
  writeBenchmarkMatrixArtifact,
  writeBenchmarkMatrixArtifactFromArtifacts,
} from "./benchmark-matrix-artifact.js";
import { EVAL_COMPARISON_ARTIFACT_SCHEMA } from "./eval-comparison-artifact.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "benchmark-matrix-"));
  tempDirs.push(dir);
  return dir;
}

describe("benchmark matrix artifacts", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("computes trained-vs-base and trained-vs-reference deltas", () => {
    const artifact = buildBenchmarkMatrixArtifactPayload({
      generatedAt: "2026-05-23T12:00:00.000Z",
      rows: [
        {
          modelId: "cerebras/gpt-oss-120b",
          provider: "cerebras",
          variant: "reference",
          benchmark: "eliza_harness_action_reason",
          score: 0.8,
        },
        {
          modelId: "gemma4-e2b-base",
          tier: "gemma4-e2b",
          variant: "base",
          benchmark: "eliza_harness_action_reason",
          score: 0.4,
        },
        {
          modelId: "gemma4-e2b-trained",
          tier: "gemma4-e2b",
          variant: "trained",
          benchmark: "eliza_harness_action_reason",
          score: 0.5,
        },
      ],
    });

    expect(artifact.schema).toBe(BENCHMARK_MATRIX_ARTIFACT_SCHEMA);
    expect(artifact.referenceModelId).toBe("cerebras/gpt-oss-120b");
    expect(artifact.counts).toMatchObject({
      rows: 3,
      comparisons: 1,
      tiers: 1,
      benchmarks: 1,
    });
    expect(artifact.comparisons[0]).toMatchObject({
      tier: "2b",
      benchmark: "eliza_harness_action_reason",
      baseScore: 0.4,
      trainedScore: 0.5,
      referenceScore: 0.8,
      improvementAbsolute: 0.1,
      improvementPercent: 25,
      trainedVsReferenceAbsolute: -0.3,
      trainedVsReferencePercent: -37.5,
      dryRun: false,
    });
  });

  it("writes the benchmark matrix artifact", async () => {
    const outputDir = await makeTempDir();
    const result = await writeBenchmarkMatrixArtifact({
      outputDir,
      rows: [
        {
          modelId: "eliza-1-2b-base",
          variant: "base",
          benchmark: "eliza_harness_action_reason",
          score: 0.55,
        },
      ],
    });

    expect(result.artifactPath).toBe(join(outputDir, "benchmark-matrix.json"));
    const onDisk = JSON.parse(await readFile(result.artifactPath, "utf-8"));
    expect(onDisk.schema).toBe(BENCHMARK_MATRIX_ARTIFACT_SCHEMA);
    expect(onDisk.tiers).toEqual(["2b"]);
  });

  it("orders Eliza-1 tiers from smallest to largest in matrix artifacts", () => {
    const artifact = buildBenchmarkMatrixArtifactPayload({
      rows: [
        {
          modelId: "eliza-1-27b-base",
          tier: "27b",
          variant: "base",
          benchmark: "eliza_harness_action_selection",
          score: 0.55,
        },
        {
          modelId: "eliza-1-4b-base",
          tier: "4b",
          variant: "base",
          benchmark: "eliza_harness_action_selection",
          score: 0.45,
        },
        {
          modelId: "eliza-1-2b-base",
          tier: "2b",
          variant: "base",
          benchmark: "eliza_harness_action_selection",
          score: 0.35,
        },
      ],
    });

    expect(artifact.tiers).toEqual(["2b", "4b", "27b"]);
    expect(artifact.comparisons.map((comparison) => comparison.tier)).toEqual([
      "2b",
      "4b",
      "27b",
    ]);
  });

  it("keeps tiered reference-only rows as benchmark comparisons", () => {
    const artifact = buildBenchmarkMatrixArtifactPayload({
      rows: [
        {
          modelId: "cerebras/gpt-oss-120b",
          provider: "cerebras",
          tier: "2b",
          variant: "reference",
          benchmark: "eliza_harness_action_selection",
          score: 1,
        },
      ],
    });

    expect(artifact.tiers).toEqual(["2b"]);
    expect(artifact.counts).toMatchObject({
      rows: 1,
      comparisons: 1,
      tiers: 1,
      benchmarks: 1,
    });
    expect(artifact.comparisons).toEqual([
      expect.objectContaining({
        tier: "2b",
        benchmark: "eliza_harness_action_selection",
        baseScore: null,
        trainedScore: null,
        referenceScore: 1,
        dryRun: false,
      }),
    ]);
  });

  it("matches tier-specific reference rows before global references", () => {
    const artifact = buildBenchmarkMatrixArtifactPayload({
      rows: [
        {
          modelId: "cerebras/gpt-oss-120b",
          provider: "cerebras",
          variant: "reference",
          benchmark: "eliza_harness_action_selection",
          score: 0.8,
        },
        {
          modelId: "cerebras/gpt-oss-120b",
          provider: "cerebras",
          tier: "2b",
          variant: "reference",
          benchmark: "eliza_harness_action_selection",
          score: 0.7,
        },
        {
          modelId: "eliza-1-4b-trained",
          tier: "4b",
          variant: "trained",
          benchmark: "eliza_harness_action_selection",
          score: 0.5,
        },
        {
          modelId: "eliza-1-2b-trained",
          tier: "2b",
          variant: "trained",
          benchmark: "eliza_harness_action_selection",
          score: 0.55,
        },
      ],
    });

    expect(
      artifact.comparisons.map((comparison) => [
        comparison.tier,
        comparison.referenceScore,
      ]),
    ).toEqual([
      ["2b", 0.7],
      ["4b", 0.8],
    ]);
  });

  it("marks comparisons as dry-run when any source row is simulated", () => {
    const artifact = buildBenchmarkMatrixArtifactPayload({
      rows: [
        {
          modelId: "eliza-1-2b-base",
          tier: "2b",
          variant: "base",
          benchmark: "eliza_harness_action_selection",
          score: 0,
          metrics: { dryRun: true },
        },
        {
          modelId: "eliza-1-2b-trained",
          tier: "2b",
          variant: "trained",
          benchmark: "eliza_harness_action_selection",
          score: 0,
          metrics: { dryRun: true },
        },
      ],
    });

    expect(artifact.comparisons).toEqual([
      expect.objectContaining({
        tier: "2b",
        benchmark: "eliza_harness_action_selection",
        dryRun: true,
        improvementPercent: null,
      }),
    ]);
  });

  it("converts action benchmark artifacts into matrix rows", () => {
    const rows = buildBenchmarkMatrixRowsFromArtifactPayload(
      {
        schema: "eliza_action_selection_benchmark_report",
        generatedAt: "2026-05-23T12:00:00.000Z",
        summary: {
          total: 10,
          passed: 7,
          failed: 3,
          accuracy: 0.7,
          plannerAccuracy: 0.8,
          executionAccuracy: 0.75,
        },
        results: [
          {
            caseId: "message-route",
            prompt: "send David the update",
            expectedAction: "MESSAGE",
            actualAction: "MESSAGE",
            pass: true,
            response: "Message queued for David.",
            latencyMs: 42,
            trajectoryPath: "/tmp/trajectories/message-route.json",
          },
        ],
      },
      {
        path: "/tmp/action-benchmark-report.json",
        modelId: "eliza-1-0b-trained",
        variant: "trained",
        tier: "0b",
      },
    );

    expect(rows).toEqual([
      expect.objectContaining({
        modelId: "eliza-1-0b-trained",
        variant: "trained",
        tier: "0b",
        benchmark: "eliza_harness_action_selection",
        score: 0.7,
        metrics: expect.objectContaining({
          plannerAccuracy: 0.8,
          executionAccuracy: 0.75,
          total: 10,
        }),
        raw: expect.objectContaining({
          caseSamples: [
            expect.objectContaining({
              caseId: "message-route",
              prompt: "send David the update",
              expectedAction: "MESSAGE",
              actualAction: "MESSAGE",
              pass: true,
              response: "Message queued for David.",
              trajectoryPath: "/tmp/trajectories/message-route.json",
            }),
          ],
        }),
      }),
    ]);
  });

  it("uses embedded action benchmark metadata when artifact source only has a path", () => {
    const rows = buildBenchmarkMatrixRowsFromArtifactPayload(
      {
        schema: "eliza_action_selection_benchmark_report",
        generatedAt: "2026-05-23T12:00:00.000Z",
        source: {
          kind: "app_core_action_selection_benchmark",
          modelId: "eliza-1-2b-trained",
          variant: "trained",
          tier: "2b",
          benchmark: "eliza_harness_action_selection",
          datasetVersion: "eliza-native-v1",
          codeCommit: "abc123",
          useMocks: true,
        },
        summary: {
          total: 10,
          passed: 7,
          failed: 3,
          accuracy: 0.7,
        },
      },
      {
        path: "/tmp/action-benchmark-report.json",
      },
    );

    expect(rows).toEqual([
      expect.objectContaining({
        modelId: "eliza-1-2b-trained",
        variant: "trained",
        tier: "2b",
        benchmark: "eliza_harness_action_selection",
        score: 0.7,
        datasetVersion: "eliza-native-v1",
        codeCommit: "abc123",
        metrics: expect.objectContaining({ useMocks: true }),
        raw: expect.objectContaining({ useMocks: true }),
      }),
    ]);
  });

  it("converts dry-run action benchmark artifacts into simulated matrix rows", () => {
    const rows = buildBenchmarkMatrixRowsFromArtifactPayload(
      {
        schema: "eliza_action_selection_benchmark_report",
        generatedAt: "2026-05-23T12:00:00.000Z",
        dryRun: true,
        source: {
          kind: "app_core_action_selection_benchmark",
          modelId: "eliza-1-2b-base",
          variant: "base",
          tier: "2b",
          benchmark: "eliza_harness_action_selection",
          dryRun: true,
        },
        summary: {
          total: 0,
          passed: 0,
          failed: 0,
        },
      },
      {
        path: "/tmp/action-benchmark-report.json",
      },
    );

    expect(rows).toEqual([
      expect.objectContaining({
        modelId: "eliza-1-2b-base",
        variant: "base",
        score: 0,
        metrics: expect.objectContaining({ dryRun: true }),
        raw: expect.objectContaining({ dryRun: true }),
      }),
    ]);
  });

  it("converts eval comparison artifacts into base and trained matrix rows", () => {
    const rows = buildBenchmarkMatrixRowsFromArtifactPayload(
      {
        schema: EVAL_COMPARISON_ARTIFACT_SCHEMA,
        generatedAt: "2026-05-23T12:00:00.000Z",
        models: {
          base: "eliza-1-0b-base",
          trained: "eliza-1-0b-trained",
        },
        metrics: {
          baseScore: 0.4,
          trainedScore: 0.52,
          improvementAbsolute: 0.12,
          improvementPercent: 30,
          promptCount: 12,
        },
      },
      {
        path: "/tmp/eval-comparison.json",
        tier: "0b",
      },
    );

    expect(rows).toEqual([
      expect.objectContaining({
        modelId: "eliza-1-0b-base",
        variant: "base",
        score: 0.4,
      }),
      expect.objectContaining({
        modelId: "eliza-1-0b-trained",
        variant: "trained",
        score: 0.52,
        metrics: expect.objectContaining({
          improvementPercent: 30,
        }),
      }),
    ]);
  });

  it("converts existing benchmark matrix artifacts into matrix rows", () => {
    const rows = buildBenchmarkMatrixRowsFromArtifactPayload(
      {
        schema: BENCHMARK_MATRIX_ARTIFACT_SCHEMA,
        rows: [
          {
            modelId: "eliza-1-2b-trained",
            variant: "trained",
            tier: "2b",
            benchmark: "hermes",
            score: 0.52,
            metrics: { improvementPercent: 30 },
          },
          {
            modelId: "cerebras/gpt-oss-120b",
            variant: "reference",
            provider: "cerebras",
            benchmark: "hermes",
            score: 0.88,
          },
        ],
      },
      {
        path: "/tmp/benchmark-matrix.json",
      },
    );

    expect(rows).toEqual([
      expect.objectContaining({
        modelId: "eliza-1-2b-trained",
        variant: "trained",
        tier: "2b",
        benchmark: "hermes",
        score: 0.52,
        metrics: expect.objectContaining({ improvementPercent: 30 }),
      }),
      expect.objectContaining({
        modelId: "cerebras/gpt-oss-120b",
        variant: "reference",
        provider: "cerebras",
        benchmark: "hermes",
        score: 0.88,
      }),
    ]);
  });

  it("writes a benchmark matrix from artifact files", async () => {
    const outputDir = await makeTempDir();
    const actionPath = join(outputDir, "action-benchmark-report.json");
    await writeFile(
      actionPath,
      JSON.stringify({
        schema: "eliza_action_selection_benchmark_report",
        generatedAt: "2026-05-23T12:00:00.000Z",
        source: {
          modelId: "eliza-1-0b-base",
          variant: "base",
          tier: "0b",
        },
        summary: {
          total: 2,
          passed: 1,
          failed: 1,
          accuracy: 0.5,
        },
      }),
      "utf-8",
    );

    const result = await writeBenchmarkMatrixArtifactFromArtifacts({
      outputDir,
      artifacts: [
        {
          path: actionPath,
        },
      ],
    });

    expect(result.artifact.rows).toEqual([
      expect.objectContaining({
        modelId: "eliza-1-0b-base",
        benchmark: "eliza_harness_action_selection",
        score: 0.5,
      }),
    ]);
  });
});
