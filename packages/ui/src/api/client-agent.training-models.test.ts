/**
 * Unit coverage for the training-model listing client verb. Transport stubbed,
 * no live agent.
 */
import { describe, expect, it, vi } from "vitest";
import "./client-agent";
import { ElizaClient } from "./client-base";

describe("ElizaClient training model listing", () => {
  it("returns training models when they are available", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn().mockResolvedValue({
      models: [
        {
          id: "trained-2b",
          createdAt: "2026-05-23T00:00:00.000Z",
          jobId: "job-1",
          outputDir: "/runs/job-1",
          modelPath: "/runs/job-1/model.gguf",
          adapterPath: null,
          sourceModel: "google/gemma-4-E2B",
          backend: "cuda",
          ollamaModel: null,
          active: false,
          benchmark: {
            status: "not_run",
            lastRunAt: null,
            output: null,
          },
        },
      ],
    });
    client.fetch = fetch;

    await expect(client.listTrainingModels()).resolves.toMatchObject({
      models: [{ id: "trained-2b" }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/training/models");
  });

  it("falls back to Vast registry models when the legacy list is empty", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({
        loaded_at: "2026-05-23T00:00:00.000Z",
        entries: [
          {
            short_name: "eliza-1-2b",
            entry: {
              eliza_short_name: "eliza-1-2b",
              eliza_repo_id: "elizaos/eliza-1",
              gguf_repo_id: "elizaos/eliza-1",
              base_hf_id: "google/gemma-4-E2B",
              tier: "2b",
              inference_max_context: 131072,
            },
          },
        ],
      });
    client.fetch = fetch;

    await expect(client.listTrainingModels()).resolves.toEqual({
      models: [
        {
          id: "eliza-1-2b",
          createdAt: "2026-05-23T00:00:00.000Z",
          jobId: "vast-registry:eliza-1-2b",
          outputDir: "elizaos/eliza-1",
          modelPath: "elizaos/eliza-1",
          adapterPath: null,
          sourceModel: "google/gemma-4-E2B",
          backend: "cuda",
          ollamaModel: null,
          active: false,
          benchmark: {
            status: "not_run",
            lastRunAt: null,
            output: "Eliza-1 2b registry entry",
          },
        },
      ],
    });
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/training/models");
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/training/vast/models");
  });

  it("keeps the legacy empty list when the Vast registry is unavailable", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ models: [] })
      .mockRejectedValueOnce(new Error("registry unavailable"));
    client.fetch = fetch;

    await expect(client.listTrainingModels()).resolves.toEqual({
      models: [],
    });
  });
});

describe("ElizaClient training collection listing", () => {
  it("posts compact all-tier collection recommendations unchanged", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn().mockResolvedValue({
      outputDir: "/tmp/collection",
      manifestPath: "/tmp/collection/collection-manifest.json",
    });
    client.fetch = fetch;

    await client.runTrainingCollection({
      actionBenchmarkPairs: "all",
      includeActionBenchmark: true,
      includeBenchmarkMatrix: true,
    });

    expect(fetch).toHaveBeenCalledWith("/api/training/collect", {
      method: "POST",
      body: JSON.stringify({
        actionBenchmarkPairs: "all",
        includeActionBenchmark: true,
        includeBenchmarkMatrix: true,
      }),
    });
  });

  it("passes the custom collection root through to the training API", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn().mockResolvedValue({
      root: "/tmp/eliza-training/collections",
      indexJsonPath: "/tmp/eliza-training/collections/collection-index.json",
      indexHtmlPath: "/tmp/eliza-training/collections/collection-index.html",
      collections: [],
    });
    client.fetch = fetch;

    await expect(
      client.listTrainingCollections({
        limit: 5,
        root: "/tmp/eliza training/collections",
      }),
    ).resolves.toMatchObject({
      root: "/tmp/eliza-training/collections",
      collections: [],
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/training/collections?limit=5&root=%2Ftmp%2Feliza+training%2Fcollections",
    );
  });

  it("preserves saved benchmark comparison highlights from collection summaries", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn().mockResolvedValue({
      root: "/tmp/eliza-training/collections",
      indexJsonPath: "/tmp/eliza-training/collections/collection-index.json",
      indexHtmlPath: "/tmp/eliza-training/collections/collection-index.html",
      collections: [
        {
          generatedAt: "2026-05-23T00:00:00.000Z",
          outputDir: "/tmp/collection-1",
          manifestPath: "/tmp/collection-1/collection-manifest.json",
          readmePath: "/tmp/collection-1/README.md",
          analysisIndexHtmlPath: "/tmp/collection-1/analysis/index.html",
          readinessStatus: "partial",
          readiness: { ready: 1, partial: 1, missing: 1 },
          readinessGaps: [
            {
              id: "all_eliza1_tiers_benchmark",
              label: "All Eliza-1 tier benchmark coverage",
              status: "missing",
              note: "Run benchmark matrix coverage for every Eliza-1 tier.",
              recommendedCapability: "terminal-training-run-collection",
              recommendedParams: { actionBenchmarkPairs: "all" },
            },
          ],
          artifactCount: 3,
          stepCounts: { skipped: 0, succeeded: 1, failed: 0 },
          dataSources: {
            huggingFaceDatasets: 0,
            feedDatasets: 0,
            naturalTrajectoryBundles: 0,
            scenarioRuns: 0,
            scenarioNativeDatasets: 0,
            testTrajectories: 0,
            trainingJsonlDatasets: 0,
          },
          sourceArtifacts: [
            {
              category: "feed",
              title: "feed-export",
              path: "/tmp/collection-1/feed/manifest.json",
              schema: "feed_training_trajectory_export",
            },
          ],
          evidenceArtifacts: [
            {
              category: "benchmark",
              title: "benchmark-matrix",
              path: "/tmp/collection-1/matrix/benchmark-matrix.json",
              schema: "eliza_benchmark_matrix_artifact",
            },
            {
              category: "eval",
              title: "eval-comparison",
              path: "/tmp/collection-1/eval/eval-comparison.json",
              schema: "eliza_local_eval_comparison_artifact",
            },
            {
              category: "model",
              title: "eliza-1-2b-trained",
              path: "/tmp/collection-1/models/2b-trained.json",
              schema: "eliza1_model_registry_entry",
            },
          ],
          training: {
            trainingRuns: 1,
            models: 1,
            modelInventory: [
              {
                title: "eliza-1-2b-trained",
                path: "/tmp/collection-1/models/2b-trained.json",
                schema: "eliza1_model_registry_entry",
                model: "eliza-1-2b-trained",
                tier: "2b",
                variant: "trained",
                outputPath: "hf://elizaos/eliza-1",
                baseModel: "google/gemma-4-E2B",
                repoId: "elizaos/eliza-1",
                evalImprovementPercent: 25,
              },
            ],
          },
          benchmarks: {
            actionBenchmarkPairs: 1,
            benchmarkComparisons: 1,
            caseSamples: 2,
            tiers: ["2b"],
            comparisonInventory: [
              {
                tier: "2b",
                benchmark: "eliza_harness_action_selection",
                baseModelId: "google/gemma-4-E2B",
                trainedModelId: "eliza-1-2b-trained",
                referenceModelId: "cerebras/gpt-oss-120b",
                baseScore: 0.4,
                trainedScore: 0.5,
                referenceScore: 0.8,
                improvementPercent: 25,
                trainedVsReferencePercent: -37.5,
                dryRun: false,
                useMocks: false,
                modelBacked: true,
              },
            ],
            baselineProgress: {
              tierOrder: ["2b", "4b", "9b", "27b", "27b-256k"],
              establishedTiers: ["2b"],
              remainingTiers: ["4b", "9b", "27b", "27b-256k"],
              nextTier: "4b",
              smallestTierEstablished: true,
              allTiersEstablished: false,
            },
          },
          evals: {
            evalArtifacts: 0,
            evalComparisons: 0,
            actionBenchmarks: 0,
            benchmarkMatrices: 1,
            comparisonInventory: [],
          },
        },
      ],
    });
    client.fetch = fetch;

    await expect(client.listTrainingCollections()).resolves.toMatchObject({
      collections: [
        {
          sourceArtifacts: [
            {
              category: "feed",
              title: "feed-export",
              path: "/tmp/collection-1/feed/manifest.json",
            },
          ],
          evidenceArtifacts: [
            {
              category: "benchmark",
              title: "benchmark-matrix",
              path: "/tmp/collection-1/matrix/benchmark-matrix.json",
            },
            {
              category: "eval",
              title: "eval-comparison",
              path: "/tmp/collection-1/eval/eval-comparison.json",
            },
            {
              category: "model",
              title: "eliza-1-2b-trained",
              path: "/tmp/collection-1/models/2b-trained.json",
            },
          ],
          training: {
            models: 1,
            modelInventory: [
              {
                model: "eliza-1-2b-trained",
                evalImprovementPercent: 25,
              },
            ],
          },
          readinessGaps: [
            {
              id: "all_eliza1_tiers_benchmark",
              recommendedCapability: "terminal-training-run-collection",
            },
          ],
          benchmarks: {
            comparisonInventory: [
              {
                tier: "2b",
                trainedVsReferencePercent: -37.5,
                modelBacked: true,
              },
            ],
          },
        },
      ],
    });
  });
});
