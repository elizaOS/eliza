import { describe, expect, it } from "vitest";
import {
  buildRunCollectionOptionsFromCliArgs,
  formatTrainingCollectionPreflightSummary,
  formatListTrainingCollectionsSummary,
  formatRunCollectionSummary,
} from "./cli.js";
import type { TrainingCollectionRunResult } from "./training-collection-runner.js";

describe("training CLI collection options", () => {
  it("builds the default smallest-tier dry-run collection recipe", () => {
    const options = buildRunCollectionOptionsFromCliArgs([]);

    expect(options).toMatchObject({
      includeHuggingFace: true,
      includeFeed: true,
      includeNaturalTrajectories: true,
      includeTestTrajectories: true,
      includeScenarios: true,
      includeActionBenchmark: true,
      includeBenchmarkVsCerebras: true,
      includeEliza1ModelRegistry: true,
      includeEliza1BundleStage: true,
      includeBenchmarkMatrix: true,
      includeEvalComparison: true,
      huggingFace: {
        repoId: "elizaos/eliza-1-training",
        revision: "main",
        dryRun: true,
      },
      feed: {
        archetypes: "trader",
        numAgents: 1,
        ticks: 1,
        parallel: 1,
        dryRun: true,
      },
      benchmarkVsCerebras: {
        tiers: "0_8b",
        benchmark: "eliza_harness_action_selection",
        dryRun: true,
      },
      evalComparison: {
        model: "eliza-1-0_8b-base",
        trainedModelPath: "eliza-1-0_8b-trained",
        backend: "cpu",
        dryRun: true,
      },
      actionBenchmark: {
        useMocks: true,
        dryRun: true,
      },
      naturalTrajectories: {
        includeRawJsonl: false,
        source: {
          kind: "training_collection_natural_trajectories",
          metadata: {
            cli: true,
          },
        },
      },
    });
    expect(options.actionBenchmarkPairs).toBeUndefined();
    expect(options.actionBenchmarkPair).toEqual({
      tier: "0_8b",
      base: {
        variant: "base",
        modelId: "eliza-1-0_8b-base",
        runtimeModel: "eliza-1-0_8b-base",
      },
      trained: {
        variant: "trained",
        modelId: "eliza-1-0_8b-trained",
        runtimeModel: "eliza-1-0_8b-trained",
      },
    });
  });

  it("preserves explicit smallest-tier collection for quick checks", () => {
    const options = buildRunCollectionOptionsFromCliArgs(["--tiers", "0_8b"]);

    expect(options.actionBenchmarkPairs).toBeUndefined();
    expect(options.actionBenchmarkPair).toMatchObject({
      tier: "0_8b",
      base: {
        variant: "base",
        modelId: "eliza-1-0_8b-base",
        runtimeModel: "eliza-1-0_8b-base",
      },
      trained: {
        variant: "trained",
        modelId: "eliza-1-0_8b-trained",
        runtimeModel: "eliza-1-0_8b-trained",
      },
    });
    expect(options.benchmarkVsCerebras).toMatchObject({
      tiers: "0_8b",
      benchmark: "eliza_harness_action_selection",
    });
  });

  it("allows explicitly skipping benchmark matrix generation", () => {
    const options = buildRunCollectionOptionsFromCliArgs(["--skip-matrix"]);

    expect(options.includeBenchmarkMatrix).toBe(false);
  });

  it("allows explicitly skipping dry-run eval comparison generation", () => {
    const options = buildRunCollectionOptionsFromCliArgs([
      "--skip-eval-comparison",
    ]);

    expect(options.includeEvalComparison).toBe(false);
  });

  it("accepts existing natural trajectory JSONL exports for collection", () => {
    const options = buildRunCollectionOptionsFromCliArgs([
      "--natural-sanitized-jsonl",
      "/tmp/app-trajectories/sanitized.jsonl",
      "--natural-raw-jsonl",
      "/tmp/app-trajectories/raw.jsonl",
      "--natural-run-id",
      "app-run-1",
      "--natural-tasks",
      "response,action_planner",
    ]);

    expect(options.includeNaturalTrajectories).toBe(true);
    expect(options.naturalTrajectories).toMatchObject({
      sanitizedJsonlPath: "/tmp/app-trajectories/sanitized.jsonl",
      rawJsonlPath: "/tmp/app-trajectories/raw.jsonl",
      includeRawJsonl: true,
      tasks: ["response", "action_planner"],
      source: {
        kind: "training_collection_natural_trajectories",
        runId: "app-run-1",
        metadata: {
          cli: true,
          sanitizedJsonlPath: "/tmp/app-trajectories/sanitized.jsonl",
          rawJsonlPath: "/tmp/app-trajectories/raw.jsonl",
        },
      },
    });
  });

  it("expands all Eliza-1 tiers for live benchmark collection", () => {
    const options = buildRunCollectionOptionsFromCliArgs([
      "--tiers",
      "all",
      "--live",
      "--output",
      "/tmp/eliza-collection",
      "--runs-per-case",
      "3",
    ]);

    expect(options.outputDir).toBe("/tmp/eliza-collection");
    expect(options.includeBenchmarkMatrix).toBe(true);
    expect(options.actionBenchmark).toMatchObject({
      runsPerCase: 3,
      dryRun: false,
      useMocks: false,
    });
    expect(options.includeEvalComparison).toBe(false);
    expect(options.actionBenchmarkPair).toBeUndefined();
    expect(options.actionBenchmarkPairs).toEqual([
      {
        tier: "0_8b",
        base: { variant: "base" },
        trained: { variant: "trained" },
      },
      {
        tier: "2b",
        base: { variant: "base" },
        trained: { variant: "trained" },
      },
      {
        tier: "4b",
        base: { variant: "base" },
        trained: { variant: "trained" },
      },
      {
        tier: "9b",
        base: { variant: "base" },
        trained: { variant: "trained" },
      },
      {
        tier: "27b",
        base: { variant: "base" },
        trained: { variant: "trained" },
      },
    ]);
    expect(options.benchmarkVsCerebras).toMatchObject({
      tiers: "0_8b,2b,4b,9b,27b",
      benchmark: "eliza_harness_action_selection",
      dryRun: false,
    });
  });

  it("builds preflight-only live collection options", () => {
    const options = buildRunCollectionOptionsFromCliArgs([
      "--preflight-only",
      "--probe-endpoints",
      "--live",
      "--tiers",
      "all",
    ]);

    expect(options.preflightOnly).toBe(true);
    expect(options.preflightProbe).toBe(true);
    expect(options.actionBenchmark).toMatchObject({
      dryRun: false,
      useMocks: false,
    });
    expect(options.benchmarkVsCerebras).toMatchObject({
      tiers: "0_8b,2b,4b,9b,27b",
      dryRun: false,
    });
  });

  it("formats collection preflight checks", () => {
    expect(
      formatTrainingCollectionPreflightSummary({
        liveRequired: true,
        checks: [
          {
            id: "app_core_action_benchmark",
            label: "App-core Eliza harness benchmark",
            status: "ok",
            detail: "found",
            path: "/repo/packages/app-core/test/benchmarks/action-selection.real.test.ts",
          },
          {
            id: "cerebras_api_key",
            label: "Cerebras API key",
            status: "missing",
            detail: "CEREBRAS_API_KEY is required",
          },
        ],
      }),
    ).toEqual([
      "[run-collection:preflight] live=yes ok=1 warning=0 missing=1 skipped=0",
      "[run-collection:preflight] app_core_action_benchmark=ok found path=/repo/packages/app-core/test/benchmarks/action-selection.real.test.ts",
      "[run-collection:preflight] cerebras_api_key=missing CEREBRAS_API_KEY is required",
    ]);
  });

  it("formats benchmark readiness and actionable gaps", () => {
    const lines = formatRunCollectionSummary({
      outputDir: "/tmp/collection",
      manifestPath: "/tmp/collection/collection-manifest.json",
      readmePath: "/tmp/collection/README.md",
      collectionIndex: {
        schema: "eliza_training_collection_index",
        schemaVersion: 1,
        generatedAt: "2026-01-02T03:04:05.000Z",
        root: "/tmp",
        indexJsonPath: "/tmp/collection-index.json",
        indexHtmlPath: "/tmp/collection-index.html",
        collections: [],
      },
      manifest: {
        analysis: { indexHtmlPath: "/tmp/collection/analysis/index.html" },
        readiness: {
          status: "partial",
          ready: 8,
          partial: 2,
          missing: 1,
        },
        evidence: {
          dataSources: {
            huggingFaceDatasets: 1,
            feedDatasets: 1,
            naturalTrajectoryBundles: 1,
            scenarioRuns: 1,
            scenarioNativeDatasets: 1,
            testTrajectories: 1,
            trainingJsonlDatasets: 2,
          },
          benchmarks: {
            actionBenchmarkPairs: 5,
            benchmarkRows: 10,
            benchmarkComparisons: 5,
            tiers: ["0_8b", "2b", "4b", "9b", "27b"],
            comparisonInventory: [
              {
                tier: "0_8b",
                benchmark: "eliza_harness_action_selection",
                baseModelId: "eliza-1-0_8b-base",
                trainedModelId: "eliza-1-0_8b-trained",
                referenceModelId: null,
                baseScore: 0.4,
                trainedScore: 0.5,
                improvementPercent: 25,
                referenceScore: 0.8,
                trainedVsReferencePercent: -37.5,
                dryRun: false,
              },
              {
                tier: "2b",
                benchmark: "eliza_harness_action_selection",
                baseModelId: "eliza-1-2b-base",
                trainedModelId: "eliza-1-2b-trained",
                referenceModelId: null,
                baseScore: 0,
                trainedScore: 0,
                improvementPercent: null,
                referenceScore: null,
                trainedVsReferencePercent: null,
                dryRun: true,
              },
            ],
            improvementComparisons: [
              {
                tier: "0_8b",
                benchmark: "eliza_harness_action_selection",
                baseScore: 0.4,
                trainedScore: 0.5,
                improvementPercent: 25,
                referenceScore: 0.8,
              },
            ],
            baselineProgress: {
              tierOrder: ["0_8b", "2b", "4b", "9b", "27b"],
              establishedTiers: ["0_8b"],
              remainingTiers: ["2b", "4b", "9b", "27b"],
              nextTier: "2b",
              smallestTierEstablished: true,
              allTiersEstablished: false,
            },
          },
          evals: {
            evalArtifacts: 12,
            evalComparisons: 1,
            actionBenchmarks: 10,
            benchmarkMatrices: 1,
          },
          training: {
            models: 2,
            trainingRuns: 1,
            modelInventory: [
              {
                title: "Eliza-1 0_8b trained",
                path: "/tmp/collection/eliza1_model_registry/0_8b-model-manifest.json",
                schema: "eliza1_model_registry_entry",
                model: "eliza-1-0_8b-trained",
                tier: "0_8b",
                variant: "trained",
                outputPath: "hf://elizaos/eliza-1-0_8b-trained",
                baseModel: "eliza-1-0_8b-base",
                repoId: "elizaos/eliza-1-0_8b-trained",
                evalImprovementPercent: null,
              },
            ],
          },
          sourceSamples: {
            huggingFace: [
              {
                title: "hf",
                path: "/tmp/collection/hf/manifest.json",
                schema: "eliza_huggingface_dataset_ingest",
                sourceKind: "huggingface_dataset",
                trajectoryId: "hf-traj-1",
                scenarioId: null,
                task: "response",
                input: "hf input",
                output: "hf output",
                model: null,
              },
            ],
            feed: [
              {
                title: "feed",
                path: "/tmp/collection/feed/manifest.json",
                schema: "feed_parallel_generation",
                sourceKind: "feed_train_parallel_generation",
                trajectoryId: "feed-traj-1",
                scenarioId: "feed-scenario",
                task: null,
                input: "BUY",
                output: "profitable and coherent",
                model: null,
              },
            ],
            natural: [
              {
                title: "natural",
                path: "/tmp/collection/natural/manifest.json",
                schema: null,
                sourceKind: "training_collection_natural_trajectories",
                trajectoryId: "natural-traj-1",
                scenarioId: null,
                task: "response",
                input: "natural input",
                output: "natural output",
                model: null,
              },
            ],
            scenarios: [],
            tests: [
              {
                title: "test",
                path: "/tmp/collection/test.json",
                schema: "eliza_test_trajectory_record",
                sourceKind: "app_core_test_trajectory",
                trajectoryId: null,
                scenarioId: "scenario-1",
                task: "action_planner",
                input: "test input",
                output: "test output",
                model: null,
              },
            ],
            trainingJsonl: [],
          },
          benchmarkReadiness: {
            smallestTier: "ready",
            allEliza1Tiers: "ready",
            baseTrainedImprovement: "ready",
            allEliza1TierImprovements: "partial",
            cerebrasReference: "missing",
          },
          readinessGaps: [
            {
              id: "feed_generation",
              status: "missing",
              recommendedCapability: "terminal-training-feed-generate",
            },
            {
              id: "huggingface_training_data",
              status: "partial",
              recommendedCapability: "terminal-training-ingest-hf-dataset",
            },
            {
              id: "cerebras_reference",
              status: "missing",
              recommendedCapability:
                "terminal-training-run-benchmark-vs-cerebras",
            },
            {
              id: "all_eliza1_tier_improvements",
              status: "partial",
              recommendedCapability: "terminal-training-run-collection",
            },
            {
              id: "eval_comparison",
              status: "partial",
              recommendedCapability: "terminal-training-run-collection",
            },
            {
              id: "model_tracking",
              status: "missing",
              recommendedCapability: "terminal-training-register-model",
            },
            {
              id: "readable_source_samples",
              status: "partial",
              recommendedCapability: "terminal-training-build-analysis-index",
            },
          ],
        },
      },
    } as TrainingCollectionRunResult);

    expect(lines).toContain("[run-collection] readme=/tmp/collection/README.md");
    expect(lines).toContain(
      "[run-collection] collection-index=/tmp/collection-index.html json=/tmp/collection-index.json",
    );
    expect(lines).toContain(
      "[run-collection] sources hf=1 feed=1 natural=1 scenarios=1 scenario-native=1 tests=1 jsonl=2",
    );
    expect(lines).toContain(
      "[run-collection] evals artifacts=12 comparisons=1 action=10 matrices=1 models=2 training-runs=1",
    );
    expect(lines).toContain(
      "[run-collection] benchmark-comparisons live=1 dry-run=1 improvements=1",
    );
    expect(lines).toContain(
      "[run-collection] benchmark-readiness smallest=ready all-tiers=ready improvement=ready all-tier-improvements=partial cerebras=missing cases=ready",
    );
    expect(lines).toContain(
      "[run-collection] source-readiness natural=ready tests=ready readable=partial",
    );
    expect(lines).toContain(
      "[run-collection] eval-readiness comparison=partial models=missing",
    );
    expect(lines).toContain(
      "[run-collection] sample-readiness readable=partial",
    );
    expect(lines).toContain(
      "[run-collection] source-samples huggingFace=1 feed=1 natural=1 scenarios=0 tests=1 trainingJsonl=0 examples=huggingFace:hf-traj-1:response feed:feed-traj-1 natural:natural-traj-1:response tests:test:action_planner",
    );
    expect(lines).toContain(
      "[run-collection] readiness-gaps feed_generation:missing->terminal-training-feed-generate cerebras_reference:missing->terminal-training-run-benchmark-vs-cerebras all_eliza1_tier_improvements:partial->terminal-training-run-collection eval_comparison:partial->terminal-training-run-collection model_tracking:missing->terminal-training-register-model",
    );
  });

  it("prioritizes missing natural and test trajectory gaps in collection summaries", () => {
    const baseResult = {
      outputDir: "/tmp/collection",
      manifestPath: "/tmp/collection/collection-manifest.json",
      readmePath: "/tmp/collection/README.md",
      collectionIndex: {
        schema: "eliza_training_collection_index",
        schemaVersion: 1,
        generatedAt: "2026-01-02T03:04:05.000Z",
        root: "/tmp",
        indexJsonPath: "/tmp/collection-index.json",
        indexHtmlPath: "/tmp/collection-index.html",
        collections: [],
      },
      manifest: {
        analysis: { indexHtmlPath: "/tmp/collection/analysis/index.html" },
        readiness: {
          status: "partial",
          ready: 0,
          partial: 0,
          missing: 2,
        },
        evidence: {
          dataSources: {
            huggingFaceDatasets: 0,
            feedDatasets: 0,
            naturalTrajectoryBundles: 0,
            scenarioRuns: 0,
            scenarioNativeDatasets: 0,
            testTrajectories: 0,
            trainingJsonlDatasets: 0,
          },
          benchmarks: {
            actionBenchmarkPairs: 0,
            benchmarkRows: 0,
            benchmarkComparisons: 0,
            tiers: [],
            comparisonInventory: [],
            improvementComparisons: [],
            baselineProgress: {
              tierOrder: ["0_8b", "2b", "4b", "9b", "27b"],
              establishedTiers: [],
              remainingTiers: ["0_8b", "2b", "4b", "9b", "27b"],
              nextTier: "0_8b",
              smallestTierEstablished: false,
              allTiersEstablished: false,
            },
          },
          evals: {
            evalArtifacts: 0,
            evalComparisons: 0,
            actionBenchmarks: 0,
            benchmarkMatrices: 0,
          },
          training: {
            models: 0,
            trainingRuns: 0,
            modelInventory: [],
          },
          sourceSamples: {
            huggingFace: [],
            feed: [],
            natural: [],
            scenarios: [],
            tests: [],
            trainingJsonl: [],
          },
          benchmarkReadiness: {
            smallestTier: "missing",
            allEliza1Tiers: "missing",
            baseTrainedImprovement: "missing",
            allEliza1TierImprovements: "missing",
            cerebrasReference: "missing",
          },
          readinessGaps: [
            {
              id: "model_tracking",
              status: "missing",
              recommendedCapability: "terminal-training-register-model",
            },
            {
              id: "test_trajectories",
              status: "missing",
              recommendedCapability: "terminal-training-run-collection",
            },
            {
              id: "natural_trajectories",
              status: "missing",
              recommendedCapability: "terminal-training-run-collection",
            },
          ],
        },
      },
    } as TrainingCollectionRunResult;

    const lines = formatRunCollectionSummary(baseResult);

    expect(lines).toContain(
      "[run-collection] source-readiness natural=missing tests=missing readable=ready",
    );
    expect(lines).toContain(
      "[run-collection] readiness-gaps natural_trajectories:missing->terminal-training-run-collection test_trajectories:missing->terminal-training-run-collection model_tracking:missing->terminal-training-register-model",
    );
  });

  it("formats saved collection run summaries for CLI discovery", () => {
    const lines = formatListTrainingCollectionsSummary({
      root: "/tmp/training/collections",
      indexJsonPath: "/tmp/training/collections/collection-index.json",
      indexHtmlPath: "/tmp/training/collections/collection-index.html",
      collections: [
        {
          generatedAt: "2026-01-02T03:04:05.000Z",
          outputDir: "/tmp/training/collections/run-1",
          manifestPath: "/tmp/training/collections/run-1/collection-manifest.json",
          readmePath: "/tmp/training/collections/run-1/README.md",
          analysisIndexHtmlPath:
            "/tmp/training/collections/run-1/analysis/index.html",
          readinessStatus: "partial",
          readiness: {
            ready: 8,
            partial: 2,
            missing: 1,
          },
          artifactCount: 24,
          stepCounts: { skipped: 1, succeeded: 10, failed: 0 },
          dataSources: {
            huggingFaceDatasets: 1,
            feedDatasets: 1,
            naturalTrajectoryBundles: 1,
            scenarioRuns: 1,
            scenarioNativeDatasets: 1,
            testTrajectories: 1,
            trainingJsonlDatasets: 2,
          },
          benchmarks: {
            actionBenchmarkPairs: 5,
            benchmarkComparisons: 5,
            caseSamples: 8,
            tiers: ["0_8b", "2b", "4b", "9b", "27b"],
            baselineProgress: {
              tierOrder: ["0_8b", "2b", "4b", "9b", "27b"],
              establishedTiers: ["0_8b", "2b"],
              remainingTiers: ["4b", "9b", "27b"],
              nextTier: "4b",
              smallestTierEstablished: true,
              allTiersEstablished: false,
            },
          },
          evals: {
            evalArtifacts: 12,
            evalComparisons: 1,
            actionBenchmarks: 10,
            benchmarkMatrices: 1,
            comparisonInventory: [
              {
                title: "Eval comparison: eliza-1-0_8b-base vs eliza-1-0_8b-trained",
                path: "/tmp/training/collections/run-1/eval_comparison/eval-comparison.json",
                baseModel: "eliza-1-0_8b-base",
                trainedModel: "eliza-1-0_8b-trained",
                backend: "cpu",
                baseScore: 0.4,
                trainedScore: 0.5,
                improvementAbsolute: 0.1,
                improvementPercent: 25,
                baseLatencyMs: 120,
                trainedLatencyMs: 150,
                latencyDeltaMs: 30,
                promptCount: 12,
                distinctResponseCount: 8,
                reportPath:
                  "/tmp/training/collections/run-1/eval_comparison/local_model_comparison.json",
              },
            ],
          },
        },
      ],
    });

    expect(lines).toEqual([
      "[list-collections] root=/tmp/training/collections",
      "[list-collections] count=1",
      "[list-collections] run=2026-01-02T03:04:05.000Z readiness=partial ready=8 partial=2 missing=1 artifacts=24 sources=hf:1,feed:1,natural:1,scenarios:1,native:1,tests:1,jsonl:2 benchmarks=pairs:5,comparisons:5,cases:8,tiers:0_8b,2b,4b,9b,27b baseline=established:0_8b,2b,next:4b,remaining:4b,9b,27b evals=artifacts:12,comparisons:1,action:10,matrices:1,first:eliza-1-0_8b-base->eliza-1-0_8b-trained,improvement:25% output=/tmp/training/collections/run-1 readme=/tmp/training/collections/run-1/README.md viewer=/tmp/training/collections/run-1/analysis/index.html",
    ]);
  });
});
