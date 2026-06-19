import { describe, expect, it } from "vitest";
import type { TrainingAnalysisIndex } from "./training-analysis-index.js";
import {
  buildTrainingReadinessReportPayload,
  TRAINING_READINESS_REPORT_SCHEMA,
} from "./training-readiness-report.js";

function analysis(
  artifacts: TrainingAnalysisIndex["manifest"]["artifacts"],
  coverage?: TrainingAnalysisIndex["manifest"]["coverage"],
): TrainingAnalysisIndex {
  return {
    outputDir: "/tmp/analysis",
    indexHtmlPath: "/tmp/analysis/index.html",
    manifestPath: "/tmp/analysis/analysis-manifest.json",
    manifest: {
      schema: "eliza_training_analysis_index",
      schemaVersion: 1,
      generatedAt: "2026-01-02T03:04:05.000Z",
      roots: ["/tmp"],
      outputDir: "/tmp/analysis",
      indexHtmlPath: "/tmp/analysis/index.html",
      manifestPath: "/tmp/analysis/analysis-manifest.json",
      counts: {
        trajectoryBundles: 0,
        trajectoryDatasets: 0,
        scenarioRuns: 0,
        collectionRuns: 0,
        trainingRuns: 0,
        evals: 0,
        benchmarkMatrices: 0,
        models: 0,
        artifacts: artifacts.length,
      },
      coverage:
        coverage ??
        {
          dataSources: {
            huggingFace: 0,
            feed: 0,
            natural: 0,
            scenarios: 0,
            tests: 0,
            trainingJsonl: 0,
          },
          readableSamples: {
            huggingFace: 0,
            feed: 0,
            natural: 0,
            scenarios: 0,
            tests: 0,
            trainingJsonl: 0,
            total: 0,
          },
          evals: {
            artifacts: 0,
            comparisons: 0,
            scoredComparisons: 0,
          },
          benchmarks: {
            matrices: 0,
            comparisons: 0,
            scoredComparisons: 0,
            caseSamples: 0,
            tiers: [],
            allEliza1TiersCovered: false,
            tierCoverage: [],
          },
          models: {
            artifacts: 0,
            inventory: [],
          },
        },
      artifacts,
    },
  };
}

function eliza1ModelRegistryArtifacts(): TrainingAnalysisIndex["manifest"]["artifacts"] {
  return ["0_8b", "2b", "4b", "9b", "27b"].flatMap((tier) =>
    (["base", "trained"] as const).map((variant) => {
      const model = `eliza-1-${tier}-${variant}`;
      return {
        id: `model:${tier}:${variant}`,
        kind: "model",
        title: model,
        path: `/tmp/${tier}-${variant}-model-manifest.json`,
        summary: {
          schema: "eliza1_model_registry_entry",
          model,
          tier,
          outputPath: `hf://elizaos/${model}`,
          baseModel: variant === "trained" ? `eliza-1-${tier}-base` : null,
        },
        payload: { variant },
      };
    }),
  );
}

describe("training readiness report", () => {
  it("marks complete coverage ready", () => {
    const report = buildTrainingReadinessReportPayload(
      analysis([
        {
          id: "hf",
          kind: "trajectory_dataset",
          title: "hf",
          path: "/tmp/hf.json",
          summary: {
            schema: "eliza_huggingface_dataset_ingest",
            source: { kind: "huggingface_dataset" },
            downloadedFiles: 2,
            jsonlRows: 12,
            hfSamplePreviews: [
              {
                trajectoryId: "hf-traj-1",
                input: "hf input",
                output: "hf output",
              },
            ],
          },
          payload: {},
        },
        {
          id: "feed",
          kind: "trajectory_dataset",
          title: "feed",
          path: "/tmp/feed.json",
          summary: { schema: "feed_parallel_generation", trajectories: 4 },
          payload: {},
        },
        {
          id: "test",
          kind: "trajectory_dataset",
          title: "test",
          path: "/tmp/test.json",
          summary: { source: { kind: "app_core_test_trajectory" }, actions: 1 },
          payload: {},
        },
        {
          id: "natural",
          kind: "trajectory_bundle",
          title: "natural",
          path: "/tmp/natural.json",
          summary: {
            source: "training_collection_natural_trajectories",
            sanitizedTrajectoryCount: 1,
          },
          payload: {},
        },
        {
          id: "scenario",
          kind: "scenario_run",
          title: "scenario",
          path: "/tmp/scenario.json",
          summary: { totalCount: 1 },
          payload: {},
        },
        {
          id: "eval",
          kind: "eval",
          title: "eval",
          path: "/tmp/eval.json",
          summary: {
            schema: "eliza_eval_comparison_artifact",
            baseScore: 0.6,
            trainedScore: 0.8,
            improvementPercent: 33.3333,
          },
          payload: {},
        },
        {
          id: "bench",
          kind: "eval",
          title: "bench",
          path: "/tmp/bench.json",
          summary: {
            schema: "eliza_action_selection_benchmark_report",
            total: 2,
            accuracy: 0.5,
          },
          payload: {},
        },
        {
          id: "matrix",
          kind: "benchmark_matrix",
          title: "matrix",
          path: "/tmp/matrix.json",
          summary: {
            rows: 3,
            comparisons: 5,
            tiers: ["0_8b", "2b", "4b", "9b", "27b"],
            referenceModelId: "cerebras/gpt-oss-120b",
          },
          payload: {
            rows: [
              ...["0_8b", "2b", "4b", "9b", "27b"].flatMap(
                (tier, index) => [
                  {
                    modelId: `eliza-1-${tier}-base`,
                    benchmark: "hermes",
                    score: 0.4 + index * 0.01,
                    variant: "base",
                    tier,
                    metrics: { useMocks: false },
                  },
                  {
                    modelId: `eliza-1-${tier}-trained`,
                    benchmark: "hermes",
                    score: 0.5 + index * 0.01,
                    variant: "trained",
                    tier,
                    metrics: { useMocks: false },
                    raw: {
                      useMocks: false,
                      caseSamples:
                        tier === "0_8b"
                          ? [
                              {
                                caseId: "message-route",
                                prompt: "send David the update",
                                expectedAction: "MESSAGE",
                                actualAction: "MESSAGE",
                                pass: true,
                                trajectoryPath: "/tmp/cases/message-route.json",
                              },
                            ]
                          : [],
                    },
                  },
                ],
              ),
            ],
            comparisons: ["0_8b", "2b", "4b", "9b", "27b"].map(
              (tier, index) => ({
                tier,
                benchmark: "hermes",
                baseScore: 0.4 + index * 0.01,
                trainedScore: 0.5 + index * 0.01,
                referenceScore: 0.8,
                improvementPercent: 25,
                referenceModelId: "cerebras/gpt-oss-120b",
              }),
            ),
          },
        },
        ...eliza1ModelRegistryArtifacts(),
        {
          id: "collection",
          kind: "collection_run",
          title: "collection",
          path: "/tmp/collection.json",
          summary: {},
          payload: {},
        },
      ]),
      { generatedAt: "2026-01-02T03:04:05.000Z" },
    );

    expect(report.schema).toBe(TRAINING_READINESS_REPORT_SCHEMA);
    expect(report.status).toBe("ready");
    expect(report.counts).toMatchObject({ ready: 17, partial: 0, missing: 0 });
    expect(report.checks.every((item) => item.recommendedAction === null)).toBe(
      true,
    );
  });

  it("requires natural runtime trajectories separately from test trajectories", () => {
    const report = buildTrainingReadinessReportPayload(
      analysis([
        {
          id: "test",
          kind: "trajectory_dataset",
          title: "test",
          path: "/tmp/test.json",
          summary: { source: { kind: "app_core_test_trajectory" }, actions: 1 },
          payload: {},
        },
      ]),
    );

    expect(
      report.checks.find((item) => item.id === "test_trajectories"),
    ).toMatchObject({
      status: "ready",
      recommendedAction: null,
    });
    expect(
      report.checks.find((item) => item.id === "natural_trajectories"),
    ).toMatchObject({
      status: "missing",
      recommendedAction: {
        capability: "terminal-training-run-collection",
        params: { includeNaturalTrajectories: true },
      },
    });
  });

  it("requires test trajectories separately from natural runtime trajectories", () => {
    const report = buildTrainingReadinessReportPayload(
      analysis([
        {
          id: "natural",
          kind: "trajectory_bundle",
          title: "natural",
          path: "/tmp/natural.json",
          summary: {
            source: { kind: "training_collection_natural_trajectories" },
            llmCalls: 2,
          },
          payload: {},
        },
      ]),
    );

    expect(
      report.checks.find((item) => item.id === "natural_trajectories"),
    ).toMatchObject({
      status: "ready",
      recommendedAction: null,
    });
    expect(
      report.checks.find((item) => item.id === "test_trajectories"),
    ).toMatchObject({
      status: "missing",
      recommendedAction: {
        capability: "terminal-training-run-collection",
        params: { includeTestTrajectories: true },
      },
    });
  });

  it("distinguishes partial eval coverage from missing coverage", () => {
    const report = buildTrainingReadinessReportPayload(
      analysis([
        {
          id: "eval",
          kind: "eval",
          title: "eval",
          path: "/tmp/eval.json",
          summary: { schema: "eliza_eval_comparison_artifact" },
          payload: {},
        },
      ]),
    );

    expect(report.status).toBe("partial");
    expect(
      report.checks.find((item) => item.id === "eval_comparison"),
    ).toMatchObject({
      status: "partial",
      recommendedAction: {
        capability: "terminal-training-run-collection",
        params: {
          includeActionBenchmark: true,
          includeBenchmarkMatrix: true,
          actionBenchmarkPairs: [
            {
              tier: "0_8b",
              base: { variant: "base" },
              trained: { variant: "trained" },
            },
          ],
        },
      },
    });
    expect(
      report.checks.find((item) => item.id === "huggingface_training_data"),
    ).toMatchObject({
      status: "missing",
    });
  });

  it("requires eval comparison percentage improvement before marking evals ready", () => {
    const report = buildTrainingReadinessReportPayload(
      analysis([
        {
          id: "eval",
          kind: "eval",
          title: "eval",
          path: "/tmp/eval.json",
          summary: {
            schema: "eliza_eval_comparison_artifact",
            baseScore: 0.4,
            trainedScore: 0.5,
          },
          payload: {},
        },
      ]),
    );

    expect(
      report.checks.find((item) => item.id === "eval_comparison"),
    ).toMatchObject({
      status: "partial",
      note:
        "A comparison artifact is present, but it does not include base score, trained score, and percentage improvement from the Eliza harness.",
      recommendedAction: {
        capability: "terminal-training-run-collection",
      },
    });
  });

  it("accepts Eliza harness benchmark improvements as base-vs-trained eval evidence", () => {
    const report = buildTrainingReadinessReportPayload(
      analysis([
        {
          id: "matrix",
          kind: "benchmark_matrix",
          title: "matrix",
          path: "/tmp/matrix.json",
          summary: {
            rows: 2,
            comparisons: 1,
          },
          payload: {
            rows: [
              {
                modelId: "eliza-1-0_8b-base",
                benchmark: "eliza_harness_action_selection",
                score: 0.4,
                variant: "base",
                tier: "0_8b",
                metrics: { useMocks: false },
              },
              {
                modelId: "eliza-1-0_8b-trained",
                benchmark: "eliza_harness_action_selection",
                score: 0.5,
                variant: "trained",
                tier: "0_8b",
                metrics: { useMocks: false },
              },
            ],
            comparisons: [
              {
                tier: "0_8b",
                benchmark: "eliza_harness_action_selection",
                baseModelId: "eliza-1-0_8b-base",
                trainedModelId: "eliza-1-0_8b-trained",
                baseScore: 0.4,
                trainedScore: 0.5,
                improvementPercent: 25,
              },
            ],
          },
        },
      ]),
    );

    expect(
      report.checks.find((item) => item.id === "eval_comparison"),
    ).toMatchObject({
      label: "Base vs trained Eliza harness eval comparison",
      status: "ready",
      recommendedAction: null,
      note:
        "A scored base-vs-trained Eliza harness or eval comparison with percentage improvement is present.",
    });
  });

  it("does not count mocked Eliza harness rows as model-backed improvement evidence", () => {
    const report = buildTrainingReadinessReportPayload(
      analysis([
        {
          id: "matrix",
          kind: "benchmark_matrix",
          title: "matrix",
          path: "/tmp/matrix.json",
          summary: {
            rows: 2,
            comparisons: 1,
          },
          payload: {
            rows: [
              {
                modelId: "eliza-1-0_8b-base",
                benchmark: "eliza_harness_action_selection",
                score: 0.4,
                variant: "base",
                tier: "0_8b",
                metrics: { useMocks: true },
              },
              {
                modelId: "eliza-1-0_8b-trained",
                benchmark: "eliza_harness_action_selection",
                score: 0.5,
                variant: "trained",
                tier: "0_8b",
                metrics: { useMocks: true },
              },
            ],
            comparisons: [
              {
                tier: "0_8b",
                benchmark: "eliza_harness_action_selection",
                baseModelId: "eliza-1-0_8b-base",
                trainedModelId: "eliza-1-0_8b-trained",
                baseScore: 0.4,
                trainedScore: 0.5,
                improvementPercent: 25,
              },
            ],
          },
        },
      ]),
    );

    expect(
      report.checks.find((item) => item.id === "eval_comparison"),
    ).toMatchObject({
      status: "partial",
      recommendedAction: {
        capability: "terminal-training-run-collection",
        params: {
          actionBenchmark: expect.objectContaining({ useMocks: false }),
        },
      },
    });
    expect(
      report.checks.find((item) => item.id === "base_trained_improvement"),
    ).toMatchObject({ status: "partial" });
  });

  it("uses analysis manifest coverage as readiness evidence", () => {
    const coverage: TrainingAnalysisIndex["manifest"]["coverage"] = {
      dataSources: {
        huggingFace: 1,
        feed: 1,
        natural: 1,
        scenarios: 2,
        tests: 1,
        trainingJsonl: 3,
      },
      readableSamples: {
        huggingFace: 1,
        feed: 1,
        natural: 1,
        scenarios: 2,
        tests: 1,
        trainingJsonl: 3,
        total: 9,
      },
      evals: {
        artifacts: 1,
        comparisons: 1,
        scoredComparisons: 1,
      },
      benchmarks: {
        matrices: 1,
        comparisons: 5,
        scoredComparisons: 5,
        caseSamples: 5,
        tiers: ["0_8b", "2b", "4b", "9b", "27b"],
        allEliza1TiersCovered: true,
        tierCoverage: ["0_8b", "2b", "4b", "9b", "27b"].map((tier) => ({
          tier,
          hasBase: true,
          hasTrained: true,
          hasReference: true,
          hasImprovement: true,
          benchmarkCount: 1,
          comparisonCount: 1,
        })),
      },
      models: {
        artifacts: 10,
        inventory: ["0_8b", "2b", "4b", "9b", "27b"].flatMap((tier) =>
          (["base", "trained"] as const).map((variant) => ({
            model: `eliza-1-${tier}-${variant}`,
            tier,
            variant,
            baseModel: variant === "trained" ? `eliza-1-${tier}-base` : null,
            outputPath: `hf://elizaos/eliza-1-${tier}-${variant}`,
            baseEvalScore: variant === "trained" ? 0.4 : null,
            trainedEvalScore: variant === "trained" ? 0.44 : null,
            evalImprovementPercent: variant === "trained" ? 10 : null,
          })),
        ),
      },
    };
    const report = buildTrainingReadinessReportPayload(
      analysis(
        [
          {
            id: "matrix",
            kind: "benchmark_matrix",
            title: "matrix",
            path: "/tmp/matrix.json",
            summary: {},
            payload: {},
          },
          {
            id: "eval",
            kind: "eval",
            title: "eval",
            path: "/tmp/eval.json",
            summary: { schema: "eliza_eval_comparison_artifact" },
            payload: {},
          },
        ],
        coverage,
      ),
    );

    expect(
      report.checks.find((item) => item.id === "readable_source_samples"),
    ).toMatchObject({
      status: "ready",
      artifactCount: 9,
      recommendedAction: null,
    });
    expect(
      report.checks.find((item) => item.id === "eval_comparison"),
    ).toMatchObject({
      status: "ready",
      artifactCount: 1,
      recommendedAction: null,
    });
    expect(
      report.checks.find((item) => item.id === "all_eliza1_tiers_benchmark"),
    ).toMatchObject({
      status: "ready",
      recommendedAction: null,
    });
    expect(
      report.checks.find((item) => item.id === "all_eliza1_tier_improvements"),
    ).toMatchObject({
      status: "ready",
      artifactCount: 5,
      recommendedAction: null,
    });
    expect(
      report.checks.find((item) => item.id === "cerebras_reference"),
    ).toMatchObject({
      status: "ready",
      recommendedAction: null,
    });
    expect(
      report.checks.find((item) => item.id === "model_tracking"),
    ).toMatchObject({
      status: "ready",
      artifactCount: 10,
      recommendedAction: null,
    });
  });

  it("marks dry-run or unscored artifacts partial rather than ready", () => {
    const report = buildTrainingReadinessReportPayload(
      analysis([
        {
          id: "hf-dry-run",
          kind: "trajectory_dataset",
          title: "hf",
          path: "/tmp/hf.json",
          summary: {
            schema: "eliza_huggingface_dataset_ingest",
            downloadedFiles: 0,
            dryRunFiles: 2,
            jsonlRows: 0,
          },
          payload: {},
        },
        {
          id: "feed-dry-run",
          kind: "trajectory_dataset",
          title: "feed",
          path: "/tmp/feed.json",
          summary: {
            schema: "feed_parallel_generation",
            trajectories: 2,
          },
          payload: { dryRun: true },
        },
        {
          id: "matrix-empty",
          kind: "benchmark_matrix",
          title: "matrix",
          path: "/tmp/matrix.json",
          summary: { rows: 0, comparisons: 0 },
          payload: {},
        },
        {
          id: "bundle-plan",
          kind: "model",
          title: "bundle",
          path: "/tmp/bundle.json",
          summary: {
            schema: "eliza1_bundle_stage",
            bundleDir: "/tmp/eliza-1-0_8b.bundle",
            apply: false,
            stagedCount: 0,
          },
          payload: {},
        },
        {
          id: "benchmark-unscored",
          kind: "eval",
          title: "bench",
          path: "/tmp/bench.json",
          summary: { schema: "eliza_action_selection_benchmark_report" },
          payload: {},
        },
      ]),
    );

    expect(report.status).toBe("partial");
    expect(
      report.checks.find((item) => item.id === "huggingface_training_data"),
    ).toMatchObject({ status: "partial" });
    expect(
      report.checks.find((item) => item.id === "huggingface_training_data")
        ?.recommendedAction,
    ).toMatchObject({
      capability: "terminal-training-ingest-hf-dataset",
      params: { dryRun: false },
    });
    expect(
      report.checks.find((item) => item.id === "feed_generation"),
    ).toMatchObject({
      status: "partial",
      note:
        "A feed generation artifact is present, but it is a dry run or has no generated trajectory rows.",
      recommendedAction: {
        capability: "terminal-training-feed-generate",
        params: { dryRun: false },
      },
    });
    expect(
      report.checks.find((item) => item.id === "benchmark_matrix"),
    ).toMatchObject({ status: "partial" });
    expect(
      report.checks.find((item) => item.id === "benchmark_case_provenance"),
    ).toMatchObject({
      status: "partial",
      recommendedAction: {
        capability: "terminal-training-run-collection",
        params: {
          includeActionBenchmark: true,
          includeBenchmarkMatrix: true,
          actionBenchmarkPairs: [
            {
              tier: "0_8b",
              base: { variant: "base" },
              trained: { variant: "trained" },
            },
          ],
        },
      },
    });
    expect(
      report.checks.find((item) => item.id === "smallest_model_benchmark"),
    ).toMatchObject({
      status: "partial",
      recommendedAction: {
        capability: "terminal-training-run-collection",
        params: {
          includeActionBenchmark: true,
          includeBenchmarkMatrix: true,
          actionBenchmarkPairs: [
            {
              tier: "0_8b",
              base: { variant: "base" },
              trained: { variant: "trained" },
            },
          ],
        },
      },
    });
    expect(
      report.checks.find((item) => item.id === "cerebras_reference"),
    ).toMatchObject({
      status: "partial",
      recommendedAction: {
        capability: "terminal-training-run-benchmark-vs-cerebras",
      },
    });
    expect(
      report.checks.find((item) => item.id === "all_eliza1_tiers_benchmark"),
    ).toMatchObject({
      status: "partial",
      recommendedAction: {
        capability: "terminal-training-run-collection",
        params: {
          includeActionBenchmark: true,
          includeBenchmarkMatrix: true,
          actionBenchmarkPairs: [
            expect.objectContaining({ tier: "0_8b" }),
            expect.objectContaining({ tier: "2b" }),
            expect.objectContaining({ tier: "4b" }),
            expect.objectContaining({ tier: "9b" }),
            expect.objectContaining({ tier: "27b" }),
          ],
        },
      },
    });
    expect(
      report.checks.find((item) => item.id === "base_trained_improvement"),
    ).toMatchObject({
      status: "partial",
      recommendedAction: {
        capability: "terminal-training-run-collection",
        params: {
          includeActionBenchmark: true,
          includeBenchmarkMatrix: true,
          actionBenchmarkPairs: [
            {
              tier: "0_8b",
              base: { variant: "base" },
              trained: { variant: "trained" },
            },
          ],
        },
      },
    });
    expect(
      report.checks.find((item) => item.id === "all_eliza1_tier_improvements"),
    ).toMatchObject({
      status: "partial",
      recommendedAction: {
        capability: "terminal-training-run-collection",
        params: {
          includeActionBenchmark: true,
          includeBenchmarkMatrix: true,
          actionBenchmarkPairs: [
            expect.objectContaining({ tier: "0_8b" }),
            expect.objectContaining({ tier: "2b" }),
            expect.objectContaining({ tier: "4b" }),
            expect.objectContaining({ tier: "9b" }),
            expect.objectContaining({ tier: "27b" }),
          ],
        },
      },
    });
    expect(
      report.checks.find((item) => item.id === "model_tracking"),
    ).toMatchObject({ status: "partial" });
    expect(
      report.checks.find((item) => item.id === "model_tracking")
        ?.recommendedAction,
    ).toMatchObject({
      capability: "terminal-training-stage-eliza1-bundle",
      params: { tier: "0_8b", apply: true },
    });
    expect(
      report.checks.find((item) => item.id === "agentic_benchmarks"),
    ).toMatchObject({ status: "partial" });
  });

  it("recommends the Eliza harness collection path for missing benchmark coverage", () => {
    const report = buildTrainingReadinessReportPayload(analysis([]));

    expect(
      report.checks.find((item) => item.id === "agentic_benchmarks"),
    ).toMatchObject({
      status: "missing",
      recommendedAction: {
        capability: "terminal-training-run-collection",
        params: {
          includeActionBenchmark: true,
          includeBenchmarkMatrix: true,
          actionBenchmark: expect.objectContaining({
            dryRun: false,
            useMocks: false,
            benchmark: "eliza_harness_action_selection",
          }),
          actionBenchmarkPair: {
            tier: "0_8b",
            base: { variant: "base" },
            trained: { variant: "trained" },
          },
        },
      },
    });
    expect(
      report.checks.find((item) => item.id === "all_eliza1_tiers_benchmark"),
    ).toMatchObject({
      recommendedAction: {
        capability: "terminal-training-run-collection",
        params: {
          actionBenchmarkPairs: [
            expect.objectContaining({ tier: "0_8b" }),
            expect.objectContaining({ tier: "2b" }),
            expect.objectContaining({ tier: "4b" }),
            expect.objectContaining({ tier: "9b" }),
            expect.objectContaining({ tier: "27b" }),
          ],
        },
      },
    });
    expect(
      report.checks.find((item) => item.id === "all_eliza1_tier_improvements"),
    ).toMatchObject({
      status: "missing",
      recommendedAction: {
        capability: "terminal-training-run-collection",
        params: {
          actionBenchmarkPairs: [
            expect.objectContaining({ tier: "0_8b" }),
            expect.objectContaining({ tier: "2b" }),
            expect.objectContaining({ tier: "4b" }),
            expect.objectContaining({ tier: "9b" }),
            expect.objectContaining({ tier: "27b" }),
          ],
        },
      },
    });
    expect(
      report.checks.find((item) => item.id === "cerebras_reference"),
    ).toMatchObject({
      recommendedAction: {
        capability: "terminal-training-run-benchmark-vs-cerebras",
      },
    });
    expect(
      report.checks.find((item) => item.id === "readable_source_samples"),
    ).toMatchObject({
      status: "missing",
      recommendedAction: {
        capability: "terminal-training-build-analysis-index",
      },
    });
  });

  it("keeps readable source samples partial until every collected source has previews", () => {
    const report = buildTrainingReadinessReportPayload(
      analysis([], {
        dataSources: {
          huggingFace: 1,
          feed: 1,
          natural: 1,
          scenarios: 0,
          tests: 0,
          trainingJsonl: 0,
        },
        readableSamples: {
          huggingFace: 1,
          feed: 1,
          natural: 0,
          scenarios: 0,
          tests: 0,
          trainingJsonl: 0,
          total: 2,
        },
        evals: {
          artifacts: 0,
          comparisons: 0,
          scoredComparisons: 0,
        },
        benchmarks: {
          matrices: 0,
          comparisons: 0,
          scoredComparisons: 0,
          caseSamples: 0,
          tiers: [],
          allEliza1TiersCovered: false,
          tierCoverage: [],
        },
        models: {
          artifacts: 0,
          inventory: [],
        },
      }),
    );

    expect(
      report.checks.find((item) => item.id === "readable_source_samples"),
    ).toMatchObject({
      status: "partial",
      artifactCount: 2,
      note:
        "Analysis coverage found collected trajectory sources that do not all expose readable samples yet.",
      recommendedAction: {
        capability: "terminal-training-build-analysis-index",
      },
    });
  });

  it("does not count non-Eliza scored evals as Eliza harness benchmark evidence", () => {
    const report = buildTrainingReadinessReportPayload(
      analysis([
        {
          id: "mmlu",
          kind: "eval",
          title: "MMLU",
          path: "/tmp/mmlu.json",
          summary: {
            benchmark: "mmlu",
            score: 0.91,
            total: 100,
          },
          payload: {
            schema: "generic_eval_report",
            benchmark: "mmlu",
          },
        },
      ]),
    );

    expect(
      report.checks.find((item) => item.id === "agentic_benchmarks"),
    ).toMatchObject({
      status: "missing",
      note: "No Eliza harness benchmark artifact was found.",
      recommendedAction: {
        capability: "terminal-training-run-collection",
        params: {
          actionBenchmark: expect.objectContaining({
            benchmark: "eliza_harness_action_selection",
          }),
        },
      },
    });
  });
});
