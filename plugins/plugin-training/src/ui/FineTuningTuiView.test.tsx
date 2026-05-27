// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openExternalUrl } from "@elizaos/ui";

vi.mock(
  "react",
  async () =>
    await import("../../../../node_modules/.bun/react@19.2.5/node_modules/react/index.js"),
);

const trainingClient = vi.hoisted(() => ({
  getTrainingStatus: vi.fn(),
  listTrainingTrajectories: vi.fn(),
  getTrainingTrajectory: vi.fn(),
  listTrainingDatasets: vi.fn(),
  buildTrainingDataset: vi.fn(),
  listTrainingJobs: vi.fn(),
  startTrainingJob: vi.fn(),
  getTrainingJob: vi.fn(),
  cancelTrainingJob: vi.fn(),
  listTrainingModels: vi.fn(),
  importTrainingModelToOllama: vi.fn(),
  activateTrainingModel: vi.fn(),
  benchmarkTrainingModel: vi.fn(),
  buildTrainingAnalysisIndex: vi.fn(),
  buildTrainingReadinessReport: vi.fn(),
  ingestHuggingFaceTrainingDataset: vi.fn(),
  runFeedTrainingGeneration: vi.fn(),
  runTrainingScenarios: vi.fn(),
  runTrainingLocalEvalComparison: vi.fn(),
  runTrainingCollection: vi.fn(),
  listTrainingCollections: vi.fn(),
  writeTrainingBenchmarkMatrix: vi.fn(),
  runTrainingBenchmarkVsCerebras: vi.fn(),
  stageEliza1Bundle: vi.fn(),
  runTrainingActionBenchmark: vi.fn(),
  onWsEvent: vi.fn(() => () => undefined),
  sendChatRest: vi.fn(),
}));

const uiExtensionMocks = vi.hoisted(() => ({
  registerDetailExtension: vi.fn(),
}));

vi.mock("@elizaos/ui", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", props, children),
  ContentLayout: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", {}, children),
  client: trainingClient,
  confirmDesktopAction: vi.fn(),
  openExternalUrl: vi.fn(),
  parsePositiveFloat: (value: string) => Number.parseFloat(value),
  parsePositiveInteger: (value: string) => Number.parseInt(value, 10),
  registerDetailExtension: uiExtensionMocks.registerDetailExtension,
  useApp: () => ({
    handleRestart: vi.fn(),
    setActionNotice: vi.fn(),
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  }),
  useIntervalWhenDocumentVisible: vi.fn(),
}));

vi.mock("./fine-tuning-panels.js", () => ({
  asTrainingEvent: vi.fn(),
  DatasetSection: () => React.createElement("section", {}, "datasets"),
  FINE_TUNING_ACTION_CLASS: "",
  FINE_TUNING_PANEL_CLASS: "",
  FINE_TUNING_SECTION_CLASS: "",
  FINE_TUNING_SECTION_HEADER_CLASS: "",
  FINE_TUNING_SECTION_KICKER_CLASS: "",
  FINE_TUNING_STATUS_CARD_CLASS: "",
  LiveEventsPanel: () => React.createElement("section", {}, "events"),
  TrainedModelsSection: () => React.createElement("section", {}, "models"),
  TrainingJobsSection: () => React.createElement("section", {}, "jobs"),
  TrajectoriesSection: () => React.createElement("section", {}, "trajectories"),
}));

import {
  FineTuningDetailExtension,
  FineTuningTuiView,
  FineTuningView,
  interact,
} from "./FineTuningView";
import type { TrainingAnalysisIndex } from "../core/training-analysis-index.js";
import { buildTrainingReadinessReportPayload } from "../core/training-readiness-report.js";
import { DEFAULT_ELIZA1_HF_DATASET_FILES } from "../core/huggingface-dataset-ingest.js";

const sampleStatus = {
  runningJobs: 1,
  queuedJobs: 1,
  completedJobs: 2,
  failedJobs: 0,
  modelCount: 1,
  datasetCount: 1,
  runtimeAvailable: true,
};

const sampleTrajectories = {
  available: true,
  total: 1,
  trajectories: [
    {
      id: "summary-1",
      trajectoryId: "trajectory-1",
      agentId: "agent-1",
      archetype: "support",
      createdAt: "2026-05-18T12:00:00.000Z",
      totalReward: 0.9,
      aiJudgeReward: null,
      episodeLength: 4,
      hasLlmCalls: true,
      llmCallCount: 3,
    },
  ],
};

const sampleDataset = {
  id: "dataset-1",
  createdAt: "2026-05-18T12:00:00.000Z",
  jsonlPath: "/tmp/dataset.jsonl",
  trajectoryDir: "/tmp/trajectories",
  metadataPath: "/tmp/metadata.json",
  sampleCount: 12,
  trajectoryCount: 3,
};

const sampleJob = {
  id: "job-1",
  createdAt: "2026-05-18T12:00:00.000Z",
  startedAt: null,
  completedAt: null,
  status: "running",
  phase: "train",
  progress: 0.5,
  error: null,
  exitCode: null,
  signal: null,
  options: { backend: "cpu", datasetId: "dataset-1" },
  datasetId: "dataset-1",
  pythonRoot: "/tmp/python",
  scriptPath: "/tmp/train.py",
  outputDir: "/tmp/out",
  logPath: "/tmp/train.log",
  modelPath: null,
  adapterPath: null,
  modelId: null,
  logs: ["step 1"],
};

const sampleModel = {
  id: "model-1",
  createdAt: "2026-05-18T12:00:00.000Z",
  jobId: "job-1",
  outputDir: "/tmp/out",
  modelPath: "/tmp/model",
  adapterPath: null,
  sourceModel: "base-model",
  backend: "cpu",
  ollamaModel: "eliza-model",
  active: true,
  benchmark: { status: "passed", lastRunAt: null, output: null },
};

const sampleAnalysisIndex = {
  outputDir: "/tmp/training-analysis",
  indexHtmlPath: "/tmp/training-analysis/index.html",
  manifestPath: "/tmp/training-analysis/analysis-manifest.json",
  manifest: {
    schema: "eliza_training_analysis_index",
    version: 1,
    generatedAt: "2026-05-18T12:00:00.000Z",
    roots: ["/tmp"],
    outputDir: "/tmp/training-analysis",
    counts: { artifacts: 9 },
    artifacts: [
      {
        id: "hf:/tmp/hf.json",
        kind: "trajectory_dataset",
        title: "hf",
        path: "/tmp/hf.json",
        summary: {
          schema: "eliza_huggingface_dataset_ingest",
          source: { kind: "huggingface_dataset" },
          hfSamplePreviews: [{ trajectoryId: "hf-traj-1" }],
        },
        payload: {},
      },
      {
        id: "feed:/tmp/feed.json",
        kind: "trajectory_dataset",
        title: "feed",
        path: "/tmp/feed.json",
        summary: {
          schema: "feed_parallel_generation",
          source: { kind: "feed_train_parallel_generation" },
          feedSamplePreviews: [{ trajectoryId: "feed-traj-1" }],
        },
        payload: {},
      },
      {
        id: "bundle:/tmp/bundle.json",
        kind: "trajectory_bundle",
        title: "natural",
        path: "/tmp/bundle.json",
        summary: {
          source: "training_collection_natural_trajectories",
          samplePreviews: [{ trajectoryId: "natural-traj-1" }],
        },
        payload: {},
      },
      {
        id: "scenario:/tmp/scenario.json",
        kind: "scenario_run",
        title: "scenario",
        path: "/tmp/scenario.json",
        summary: {
          scenarioIds: ["deterministic-pr-smoke"],
          turnPreviews: [{ scenarioId: "deterministic-pr-smoke" }],
        },
        payload: {},
      },
      {
        id: "test:/tmp/test.json",
        kind: "trajectory_dataset",
        title: "test trajectory",
        path: "/tmp/test.json",
        summary: {
          schema: "eliza_test_trajectory_record",
          source: { kind: "app_core_test_trajectory" },
          testSamplePreviews: [{ scenarioId: "test-scenario" }],
        },
        payload: {},
      },
      {
        id: "jsonl:/tmp/train.jsonl",
        kind: "trajectory_dataset",
        title: "train",
        path: "/tmp/train.jsonl",
        summary: {
          schema: "eliza_training_jsonl_dataset",
          samplePreviews: [{ trajectoryId: "jsonl-traj-1" }],
        },
        payload: {},
      },
      {
        id: "eval:/tmp/eval.json",
        kind: "eval",
        title: "eval.json",
        path: "/tmp/eval.json",
        summary: { schema: "eliza_training_readiness_report" },
        payload: {},
      },
      {
        id: "benchmark:/tmp/benchmark.json",
        kind: "benchmark_matrix",
        title: "benchmark",
        path: "/tmp/benchmark.json",
        summary: {
          schema: "eliza_benchmark_matrix_artifact",
          modelStats: [
            {
              modelId: "eliza-1-0_8b-trained",
              averageScore: 0.72,
            },
          ],
        },
        payload: {
          comparisons: [
            {
              tier: "0_8b",
              benchmark: "eliza_harness_action_selection",
              baseScore: 0.4,
              trainedScore: 0.5,
              referenceScore: 0.8,
              improvementPercent: 25,
              trainedVsReferencePercent: -37.5,
            },
          ],
        },
      },
      {
        id: "model:/tmp/model.json",
        kind: "model",
        title: "model",
        path: "/tmp/model.json",
        summary: { model: "eliza-1-0_8b-trained" },
        payload: {},
      },
    ],
  },
};

const sampleReadinessReport = {
  outputDir: "/tmp/training-analysis",
  reportPath: "/tmp/training-analysis/training-readiness-report.json",
  report: {
    schema: "eliza_training_readiness_report",
    schemaVersion: 1,
    generatedAt: "2026-05-18T12:00:00.000Z",
    outputDir: "/tmp/training-analysis",
    reportPath: "/tmp/training-analysis/training-readiness-report.json",
    analysisManifestPath: "/tmp/training-analysis/analysis-manifest.json",
    analysisIndexHtmlPath: "/tmp/training-analysis/index.html",
    status: "partial",
    counts: { checks: 9, ready: 4, partial: 1, missing: 4, artifacts: 12 },
    checks: [
      {
        id: "all_eliza1_tiers_benchmark",
        label: "All Eliza-1 tier benchmark coverage",
        status: "missing",
        artifactCount: 0,
        artifactPaths: [],
        note: "No benchmark matrix proves all Eliza-1 tiers.",
        recommendedAction: {
          label: "Run all-tier action benchmark collection",
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
            ],
          },
        },
      },
    ],
  },
};

const sampleBenchmarkMatrix = {
  outputDir: "/tmp/benchmark-matrix",
  artifactPath: "/tmp/benchmark-matrix/benchmark-matrix.json",
  artifact: {
    schema: "eliza_benchmark_matrix_artifact",
    version: 1,
    generatedAt: "2026-05-18T12:00:00.000Z",
    source: { kind: "test" },
    referenceModelId: "cerebras/gpt-oss-120b",
    tiers: ["0b"],
    benchmarks: ["eliza_harness_action_reason"],
    counts: { rows: 3, comparisons: 1, tiers: 1, benchmarks: 1 },
    rows: [],
    comparisons: [],
  },
};

const sampleHfIngest = {
  outputDir: "/tmp/hf-datasets/eliza-1-training",
  manifestPath:
    "/tmp/hf-datasets/eliza-1-training/huggingface-dataset-manifest.json",
  manifest: {
    schema: "eliza_huggingface_dataset_ingest",
    schemaVersion: 1,
    generatedAt: "2026-05-18T12:00:00.000Z",
    source: {
      kind: "huggingface_dataset",
      repoId: "elizaos/eliza-1-training",
      revision: "main",
    },
    outputDir: "/tmp/hf-datasets/eliza-1-training",
    manifestPath:
      "/tmp/hf-datasets/eliza-1-training/huggingface-dataset-manifest.json",
    counts: { files: 1, downloadedFiles: 0, dryRunFiles: 1, jsonlRows: 0 },
    files: [],
  },
};

const sampleBenchmarkRun = {
  trainingRoot: "/repo/packages/training",
  outputDir: "/tmp/benchmark-run",
  matrixOutputDir: "/tmp/benchmark-matrix",
  matrixArtifactPath: "/tmp/benchmark-matrix/benchmark-matrix.json",
  resultsDb: "/tmp/results.db",
  command: ["python3", "scripts/benchmark_vs_cerebras.py"],
  stdout: "ok",
  stderr: "",
  exitCode: 0,
};

const sampleEliza1BundleStage = {
  trainingRoot: "/repo/packages/training",
  outputDir: "/tmp/eliza-stage",
  manifestPath: "/tmp/eliza-stage/eliza1-bundle-stage-manifest.json",
  command: [
    "python3",
    "/repo/packages/training/scripts/manifest/stage_hf_eliza1_bundle.py",
  ],
  stdout: "ok",
  stderr: "",
  exitCode: 0,
  plan: {
    repoId: "elizaos/eliza-1",
    tier: "0_8b",
    bundleDir: "/tmp/eliza-1-bundles/eliza-1-0_8b.bundle",
    fileCount: 72,
    plannedBytes: 1_960_000_000,
    apply: false,
  },
  manifest: {
    schema: "eliza1_bundle_stage",
    schemaVersion: 1,
    generatedAt: "2026-05-18T12:00:00.000Z",
    trainingRoot: "/repo/packages/training",
    outputDir: "/tmp/eliza-stage",
    manifestPath: "/tmp/eliza-stage/eliza1-bundle-stage-manifest.json",
    command: [
      "python3",
      "/repo/packages/training/scripts/manifest/stage_hf_eliza1_bundle.py",
    ],
    exitCode: 0,
    repoId: "elizaos/eliza-1",
    tier: "0_8b",
    bundleDir: "/tmp/eliza-1-bundles/eliza-1-0_8b.bundle",
    fileCount: 72,
    plannedBytes: 1_960_000_000,
    maxBytes: 8_589_934_592,
    apply: false,
    stagedCount: 0,
    plan: null,
  },
};

const sampleFeedGenerationRun = {
  workspaceRoot: "/repo",
  feedCliRoot: "/repo/packages/feed/apps/cli",
  outputDir: "/tmp/feed-generation",
  artifacts: [
    {
      schema: "feed_parallel_generation",
      manifestPath: "/tmp/feed-generation/feed-parallel.manifest.json",
      exportPath: "/tmp/feed-generation/feed-generated-trajectories.jsonl",
      outputDir: "/tmp/feed-generation",
      sourceKind: "feed_train_parallel_generation",
      trajectories: 2,
      archetypes: ["trader"],
      generatedAt: "2026-01-02T03:04:05.000Z",
    },
  ],
  command: ["bun", "run", "src/index.ts", "train", "parallel"],
  stdout: "ok",
  stderr: "",
  exitCode: 0,
};

const sampleActionBenchmarkRun = {
  workspaceRoot: "/repo",
  appCoreRoot: "/repo/packages/app-core",
  outputDir: "/tmp/action-benchmark",
  reportMarkdownPath: "/tmp/action-benchmark/action-benchmark-report.md",
  reportJsonPath: "/tmp/action-benchmark/action-benchmark-report.json",
  trajectoryDir: "/tmp/action-benchmark/trajectories",
  command: [
    "bun",
    "run",
    "test",
    "test/benchmarks/action-selection.real.test.ts",
  ],
  env: { ELIZA_RUN_ACTION_BENCHMARK: "1" },
  stdout: "ok",
  stderr: "",
  exitCode: 0,
  matrixSource: null,
};

const sampleCollectionRun = {
  outputDir: "/tmp/training-collection",
  manifestPath: "/tmp/training-collection/collection-manifest.json",
  readmePath: "/tmp/training-collection/README.md",
  collectionIndex: {
    schema: "eliza_training_collection_index",
    schemaVersion: 1,
    generatedAt: "2026-05-18T12:00:00.000Z",
    root: "/tmp/training",
    indexJsonPath: "/tmp/training/collection-index.json",
    indexHtmlPath: "/tmp/training/collection-index.html",
    collections: [],
  },
  manifest: {
    schema: "eliza_training_collection_run",
    schemaVersion: 1,
    generatedAt: "2026-05-18T12:00:00.000Z",
    outputDir: "/tmp/training-collection",
    manifestPath: "/tmp/training-collection/collection-manifest.json",
    readmePath: "/tmp/training-collection/README.md",
    provenance: {
      generatedBy: "plugin-training",
      workspaceRoot: "/workspace/eliza",
      trainingStateRoot: "/tmp/training",
      analysisRoots: ["/tmp/training-collection"],
      outputLayout: {
        collection: "/tmp/training-collection",
        analysis: "/tmp/training-collection/analysis",
        steps: "/tmp/training-collection",
      },
    },
    recipe: {
      include: {
        huggingFace: true,
        feed: true,
        naturalTrajectories: true,
        testTrajectories: true,
        scenarios: true,
        evalComparison: false,
        actionBenchmark: true,
        benchmarkVsCerebras: true,
        eliza1BundleStage: true,
        benchmarkMatrix: true,
      },
      sources: {
        huggingFace: { repoId: "elizaos/eliza-1-training" },
        feed: { archetypes: "trader", ticks: 1 },
        naturalTrajectories: {},
        testTrajectories: {},
        scenarios: { scenario: "deterministic-pr-smoke" },
      },
      evals: {
        evalComparison: {},
        actionBenchmark: { benchmark: "eliza_harness_action_selection" },
        actionBenchmarkPair: null,
        actionBenchmarkPairs: [
          { tier: "0_8b" },
          { tier: "2b" },
          { tier: "4b" },
          { tier: "9b" },
          { tier: "27b" },
        ],
        benchmarkVsCerebras: { tiers: "0_8b,2b,4b,9b,27b" },
        benchmarkMatrix: {},
      },
      training: {
        eliza1BundleStage: { tier: "0_8b" },
      },
    },
    analysis: {
      outputDir: "/tmp/training-collection/analysis",
      indexHtmlPath: "/tmp/training-collection/analysis/index.html",
      manifestPath: "/tmp/training-collection/analysis/analysis-manifest.json",
      artifactCount: 8,
    },
    readiness: {
      outputDir: "/tmp/training-collection/analysis",
      reportPath:
        "/tmp/training-collection/analysis/training-readiness-report.json",
      status: "partial",
      ready: 5,
      partial: 2,
      missing: 6,
    },
    evidence: {
      preflight: {
        liveRequired: true,
        checks: [
          {
            id: "app_core_action_benchmark",
            label: "App-core Eliza harness benchmark",
            status: "ok",
            detail: "found",
            path: "/workspace/eliza/packages/app-core/test/benchmarks/action-selection.real.test.ts",
          },
          {
            id: "action_benchmark_provider",
            label: "Action benchmark provider",
            status: "warning",
            detail:
              "local provider selected; verify OpenAI-compatible endpoint is serving at http://localhost:11434/v1",
          },
          {
            id: "cerebras_api_key",
            label: "Cerebras API key",
            status: "missing",
            detail:
              "CEREBRAS_API_KEY is required for live Cerebras reference runs",
          },
          {
            id: "action_benchmark_endpoint",
            label: "Action benchmark endpoint",
            status: "ok",
            detail:
              "OpenAI-compatible endpoint responded at http://localhost:11434/v1/models",
          },
        ],
      },
      viewerHtmlPath: "/tmp/training-collection/analysis/index.html",
      analysisManifestPath:
        "/tmp/training-collection/analysis/analysis-manifest.json",
      readinessReportPath:
        "/tmp/training-collection/analysis/training-readiness-report.json",
      artifactCounts: { artifacts: 8 },
      stepCounts: { skipped: 0, succeeded: 9, failed: 0 },
      stepArtifacts: [
        {
          stepId: "action_benchmark",
          status: "succeeded",
          outputDir: "/tmp/action",
          command: [
            "bun",
            "run",
            "test",
            "test/benchmarks/action-selection.real.test.ts",
          ],
          exitCode: 0,
          paths: [
            {
              label: "reportJsonPath",
              path: "/tmp/action/action-benchmark-report.json",
            },
            {
              label: "trajectoryDir",
              path: "/tmp/action/trajectories",
            },
          ],
        },
      ],
      dataSources: {
        huggingFaceDatasets: 1,
        feedDatasets: 1,
        naturalTrajectoryBundles: 1,
        scenarioRuns: 1,
        scenarioNativeDatasets: 1,
        testTrajectories: 1,
        trainingJsonlDatasets: 2,
      },
      feed: {
        runs: [
          {
            title: "feed",
            path: "/tmp/feed.json",
            schema: "feed_parallel_generation",
            sourceKind: "feed_train_parallel_generation",
            archetype: "trader",
            archetypes: null,
            trajectories: 4,
            totalTicks: 12,
            durationMs: 900,
            errors: 0,
            exportPath: "/tmp/feed.jsonl",
            outputDir: "/tmp/feed",
          },
        ],
        archetypeStats: [
          {
            title: "feed",
            path: "/tmp/feed.json",
            archetype: "trader",
            agents: 1,
            trajectories: 4,
            avgTicksPerAgent: 12,
          },
        ],
        trajectorySamples: [
          {
            title: "feed",
            path: "/tmp/feed.json",
            trajectoryId: "feed-traj-1",
            agentId: "feed-agent-1",
            archetype: "trader",
            scenarioId: "multi-archetype-trader",
            score: 0.87,
            finalPnl: 42,
            steps: 1,
            firstStep: "BUY",
            reasoning: "profitable and coherent",
          },
        ],
      },
      sourceSamples: {
        huggingFace: [],
        feed: [
          {
            title: "feed",
            path: "/tmp/feed.json",
            schema: "feed_parallel_generation",
            sourceKind: "feed_train_parallel_generation",
            trajectoryId: "feed-traj-1",
            scenarioId: "multi-archetype-trader",
            task: null,
            input: "BUY",
            output: "profitable and coherent",
            model: null,
          },
        ],
        natural: [],
        scenarios: [],
        tests: [],
        trainingJsonl: [],
      },
      training: {
        trainingRuns: 0,
        models: 2,
        modelInventory: [
          {
            title: "eliza-1-0_8b-base",
            path: "/tmp/eliza1_model_registry/0_8b-base-model-manifest.json",
            schema: "eliza1_model_registry_entry",
            model: "eliza-1-0_8b-base",
            tier: "0_8b",
            variant: "base",
            outputPath: "hf://elizaos/eliza-1-0_8b-base",
            baseModel: null,
            repoId: "elizaos/eliza-1-0_8b-base",
            baseEvalScore: null,
            trainedEvalScore: null,
            evalImprovementPercent: null,
          },
          {
            title: "eliza-1-0_8b-trained",
            path: "/tmp/eliza1_model_registry/0_8b-trained-model-manifest.json",
            schema: "eliza1_model_registry_entry",
            model: "eliza-1-0_8b-trained",
            tier: "0_8b",
            variant: "trained",
            outputPath: "hf://elizaos/eliza-1-0_8b-trained",
            baseModel: "eliza-1-0_8b-base",
            repoId: "elizaos/eliza-1-0_8b-trained",
            baseEvalScore: 0.4,
            trainedEvalScore: 0.5,
            evalImprovementPercent: 25,
          },
        ],
      },
      evals: {
        evalArtifacts: 2,
        actionBenchmarks: 1,
        evalComparisons: 1,
        benchmarkMatrices: 1,
        comparisonInventory: [
          {
            title: "Eval comparison: eliza-1-0_8b-base vs eliza-1-0_8b-trained",
            path: "/tmp/eval/eval-comparison.json",
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
            reportPath: "/tmp/eval/local_model_comparison.json",
          },
        ],
      },
      artifactLinks: [
        {
          category: "huggingface",
          kind: "trajectory_dataset",
          title: "hf",
          path: "/tmp/hf.json",
          schema: "eliza_huggingface_dataset_ingest",
        },
        {
          category: "feed",
          kind: "trajectory_dataset",
          title: "feed",
          path: "/tmp/feed.json",
          schema: "feed_parallel_generation",
        },
        {
          category: "benchmark",
          kind: "benchmark_matrix",
          title: "benchmark",
          path: "/tmp/benchmark.json",
          schema: "eliza_benchmark_matrix_artifact",
        },
      ],
      benchmarks: {
        actionBenchmarkPairs: 1,
        actionBenchmarkMatrixSources: 2,
        benchmarkRows: 3,
        benchmarkComparisons: 1,
        tiers: ["0_8b"],
        comparisonInventory: [
          {
            tier: "0_8b",
            benchmark: "eliza_harness_action_selection",
            baseScore: 0.4,
            trainedScore: 0.5,
            referenceScore: 0.8,
            improvementPercent: 25,
            dryRun: false,
            useMocks: false,
            modelBacked: true,
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
            modelBacked: true,
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
        caseSamples: [
          {
            tier: "0_8b",
            variant: "trained",
            modelId: "eliza-1-0_8b-trained",
            benchmark: "eliza_harness_action_selection",
            score: 0.5,
            caseId: "message-route",
            prompt: "send David the update",
            expectedAction: "MESSAGE",
            actualAction: "MESSAGE",
            pass: true,
            response: "Message queued for David.",
            latencyMs: 42,
            trajectoryPath: "/tmp/action/cases/message-route.json",
            useMocks: false,
          },
        ],
      },
      benchmarkReadiness: {
        smallestTier: "ready",
        allEliza1Tiers: "missing",
        allEliza1TierImprovements: "missing",
        cerebrasReference: "ready",
        baseTrainedImprovement: "ready",
      },
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
    },
    steps: [
      {
        id: "huggingface",
        status: "succeeded",
        outputDir: "/tmp/hf",
        error: null,
        result: null,
      },
      {
        id: "feed",
        status: "succeeded",
        outputDir: "/tmp/feed",
        error: null,
        result: null,
      },
      {
        id: "natural_trajectories",
        status: "succeeded",
        outputDir: "/tmp/natural",
        error: null,
        result: null,
      },
      {
        id: "scenarios",
        status: "succeeded",
        outputDir: "/tmp/scenarios",
        error: null,
        result: null,
      },
      {
        id: "eval_comparison",
        status: "succeeded",
        outputDir: "/tmp/eval",
        error: null,
        result: null,
      },
      {
        id: "action_benchmark",
        status: "succeeded",
        outputDir: "/tmp/action",
        error: null,
        result: null,
      },
      {
        id: "benchmark_vs_cerebras",
        status: "succeeded",
        outputDir: "/tmp/benchmark",
        error: null,
        result: null,
      },
      {
        id: "eliza1_bundle_stage",
        status: "succeeded",
        outputDir: "/tmp/stage",
        error: null,
        result: null,
      },
      {
        id: "benchmark_matrix",
        status: "succeeded",
        outputDir: "/tmp/matrix",
        error: null,
        result: null,
      },
    ],
  },
  analysis: sampleAnalysisIndex,
};

const sampleCollectionHistory = {
  root: "/tmp/training/collections",
  indexJsonPath: "/tmp/training/collections/collection-index.json",
  indexHtmlPath: "/tmp/training/collections/collection-index.html",
  collections: [
    {
      generatedAt: "2026-05-18T12:00:00.000Z",
      outputDir: "/tmp/training-collection",
      manifestPath: "/tmp/training-collection/collection-manifest.json",
      readmePath: "/tmp/training-collection/README.md",
      analysisIndexHtmlPath: "/tmp/training-collection/analysis/index.html",
      readinessStatus: "partial",
      readiness: {
        ready: 5,
        partial: 2,
        missing: 6,
      },
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
      artifactCount: 8,
      stepCounts: { skipped: 0, succeeded: 9, failed: 0 },
      dataSources: {
        huggingFaceDatasets: 1,
        feedDatasets: 1,
        naturalTrajectoryBundles: 1,
        scenarioRuns: 1,
        scenarioNativeDatasets: 1,
        testTrajectories: 1,
        trainingJsonlDatasets: 2,
      },
      sourceSamples: {
        huggingFace: [
          {
            title: "hf-history",
            path: "/tmp/training-collection/hf/manifest.json",
            schema: "eliza_huggingface_dataset_ingest",
            sourceKind: "huggingface_dataset",
            trajectoryId: "hf-history-traj",
            scenarioId: null,
            task: "response",
            input: "hf history input",
            output: "hf history output",
            model: "eliza-1-0_8b-base",
          },
        ],
        feed: [
          {
            title: "feed-history",
            path: "/tmp/training-collection/feed/feed-dry-run.manifest.json",
            schema: "feed_parallel_generation",
            sourceKind: "feed_train_parallel_generation",
            trajectoryId: "feed-history-traj",
            scenarioId: null,
            task: "market_tick",
            input: "feed history input",
            output: "feed history output",
            model: null,
          },
        ],
        natural: [],
        scenarios: [],
        tests: [],
        trainingJsonl: [],
      },
      sourceArtifacts: [
        {
          category: "feed",
          title: "feed-history",
          path: "/tmp/training-collection/feed/feed-dry-run.manifest.json",
          schema: "feed_parallel_generation",
        },
        {
          category: "training_jsonl",
          title: "feed-history-trajectories.jsonl",
          path: "/tmp/training-collection/feed/feed-history-trajectories.jsonl",
          schema: "eliza_training_jsonl_dataset",
        },
      ],
      evidenceArtifacts: [
        {
          category: "benchmark",
          title: "benchmark-history",
          path: "/tmp/training-collection/matrix/benchmark-matrix.json",
          schema: "eliza_benchmark_matrix_artifact",
        },
        {
          category: "eval",
          title: "eval-history",
          path: "/tmp/training-collection/eval/eval-comparison.json",
          schema: "eliza_local_eval_comparison_artifact",
        },
        {
          category: "model",
          title: "eliza-1-0_8b-trained",
          path: "/tmp/training-collection/models/0_8b-trained.json",
          schema: "eliza1_model_registry_entry",
        },
      ],
      training: {
        trainingRuns: 1,
        models: 2,
        modelInventory: [
          {
            title: "eliza-1-0_8b-trained",
            path: "/tmp/training-collection/models/0_8b-trained.json",
            schema: "eliza1_model_registry_entry",
            model: "eliza-1-0_8b-trained",
            tier: "0_8b",
            variant: "trained",
            outputPath: "hf://elizaos/eliza-1-0_8b-trained",
            baseModel: "eliza-1-0_8b-base",
            repoId: "elizaos/eliza-1-0_8b-trained",
            baseEvalScore: 0.4,
            trainedEvalScore: 0.5,
            evalImprovementPercent: 25,
          },
        ],
      },
      benchmarks: {
        actionBenchmarkPairs: 1,
        benchmarkComparisons: 1,
        caseSamples: 1,
        tiers: ["0_8b"],
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
        evalArtifacts: 2,
        evalComparisons: 1,
        actionBenchmarks: 1,
        benchmarkMatrices: 1,
        comparisonInventory: [
          {
            title: "Eval comparison: eliza-1-0_8b-base vs eliza-1-0_8b-trained",
            path: "/tmp/eval/eval-comparison.json",
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
            reportPath: "/tmp/eval/local_model_comparison.json",
          },
        ],
      },
      coverage: {
        dataSources: {
          huggingFace: 1,
          feed: 1,
          natural: 1,
          scenarios: 1,
          tests: 1,
          trainingJsonl: 2,
        },
        readableSamples: {
          huggingFace: 1,
          feed: 1,
          natural: 1,
          scenarios: 1,
          tests: 1,
          trainingJsonl: 2,
          total: 7,
        },
        evals: {
          artifacts: 2,
          comparisons: 1,
          scoredComparisons: 1,
        },
        benchmarks: {
          matrices: 1,
          comparisons: 1,
          scoredComparisons: 1,
          caseSamples: 1,
          tiers: ["0_8b"],
          allEliza1TiersCovered: false,
          tierCoverage: [
            {
              tier: "0_8b",
              hasBase: true,
              hasTrained: true,
              hasReference: true,
              hasImprovement: true,
              benchmarkCount: 1,
              comparisonCount: 1,
            },
          ],
        },
        models: {
          artifacts: 2,
          stagedBundles: 0,
          inventoryCount: 2,
        },
      },
    },
  ],
};

function emptyAnalysisIndex(): TrainingAnalysisIndex {
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
        artifacts: 0,
      },
      artifacts: [],
    },
  };
}

function mockState() {
  trainingClient.getTrainingStatus.mockResolvedValue(sampleStatus);
  trainingClient.listTrainingTrajectories.mockResolvedValue(sampleTrajectories);
  trainingClient.getTrainingTrajectory.mockResolvedValue({
    trajectory: {
      ...sampleTrajectories.trajectories[0],
      stepsJson: "[]",
      aiJudgeReasoning: null,
    },
  });
  trainingClient.listTrainingDatasets.mockResolvedValue({
    datasets: [sampleDataset],
  });
  trainingClient.buildTrainingDataset.mockResolvedValue({
    dataset: sampleDataset,
  });
  trainingClient.listTrainingJobs.mockResolvedValue({ jobs: [sampleJob] });
  trainingClient.startTrainingJob.mockResolvedValue({ job: sampleJob });
  trainingClient.cancelTrainingJob.mockResolvedValue({ ok: true });
  trainingClient.listTrainingModels.mockResolvedValue({
    models: [sampleModel],
  });
  trainingClient.importTrainingModelToOllama.mockResolvedValue({
    model: sampleModel,
  });
  trainingClient.activateTrainingModel.mockResolvedValue({
    modelId: "model-1",
    providerModel: "ollama/eliza-model",
    needsRestart: false,
  });
  trainingClient.benchmarkTrainingModel.mockResolvedValue({
    status: "passed",
  });
  trainingClient.buildTrainingAnalysisIndex.mockResolvedValue(
    sampleAnalysisIndex,
  );
  trainingClient.buildTrainingReadinessReport.mockResolvedValue(
    sampleReadinessReport,
  );
  trainingClient.ingestHuggingFaceTrainingDataset.mockResolvedValue(
    sampleHfIngest,
  );
  trainingClient.writeTrainingBenchmarkMatrix.mockResolvedValue(
    sampleBenchmarkMatrix,
  );
  trainingClient.runTrainingBenchmarkVsCerebras.mockResolvedValue(
    sampleBenchmarkRun,
  );
  trainingClient.stageEliza1Bundle.mockResolvedValue(sampleEliza1BundleStage);
  trainingClient.runTrainingActionBenchmark.mockResolvedValue(
    sampleActionBenchmarkRun,
  );
  trainingClient.runFeedTrainingGeneration.mockResolvedValue(
    sampleFeedGenerationRun,
  );
  trainingClient.runTrainingCollection.mockResolvedValue(sampleCollectionRun);
  trainingClient.listTrainingCollections.mockResolvedValue(
    sampleCollectionHistory,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FineTuningTuiView", () => {
  it("registers and renders the fine-tuning app detail dashboard", async () => {
    mockState();

    expect(uiExtensionMocks.registerDetailExtension).toHaveBeenCalledWith(
      "plugin-dash-fine-tuning",
      FineTuningDetailExtension,
    );

    render(
      React.createElement(FineTuningDetailExtension, {
        app: {
          name: "@elizaos/plugin-training",
          displayName: "Fine Tuning",
        } as never,
      }),
    );

    expect(
      await screen.findByTestId("fine-tuning-detail-extension"),
    ).toBeTruthy();
    expect(await screen.findByText("Latest training collection")).toBeTruthy();
    expect(await screen.findByText("Readable samples")).toBeTruthy();
    expect(await screen.findByText("7")).toBeTruthy();
    expect(await screen.findByText("Scored evals")).toBeTruthy();
    expect(await screen.findByText("Models")).toBeTruthy();
    expect(await screen.findByText("Next gaps")).toBeTruthy();
    expect(
      await screen.findByText("all_eliza1_tiers_benchmark:missing"),
    ).toBeTruthy();
    expect(await screen.findByText(/established 0_8b \/ next 2b/)).toBeTruthy();
    expect(await screen.findByText("2b, 4b, 9b, 27b")).toBeTruthy();
    expect(trainingClient.listTrainingCollections).toHaveBeenCalledWith({
      limit: 3,
    });

    fireEvent.click(
      await screen.findByTitle("terminal-training-run-collection"),
    );
    await waitFor(() => {
      expect(trainingClient.runTrainingCollection).toHaveBeenCalledWith(
        expect.objectContaining({
          actionBenchmarkPairs: expect.arrayContaining([
            expect.objectContaining({ tier: "0_8b" }),
            expect.objectContaining({ tier: "27b" }),
          ]),
        }),
      );
    });

    fireEvent.click(await screen.findByText("Open analysis"));
    fireEvent.click(await screen.findByText("Open run index"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/training-collection/analysis/index.html",
    );
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/training/collections/collection-index.html",
    );
  });

  it("runs Hugging Face dataset ingest from the visible fine-tuning view", async () => {
    mockState();

    render(React.createElement(FineTuningView));

    const ingestButton = await screen.findByText(
      "finetuningview.IngestHuggingFaceDataset",
    );
    fireEvent.click(ingestButton);

    await screen.findByText("/tmp/hf-datasets/eliza-1-training");
    expect(
      trainingClient.ingestHuggingFaceTrainingDataset,
    ).toHaveBeenCalledWith({
      repoId: "elizaos/eliza-1-training",
      revision: "main",
      files: DEFAULT_ELIZA1_HF_DATASET_FILES,
      outputDir: undefined,
      dryRun: true,
    });
    fireEvent.click(await screen.findByText("Open HF manifest"));
    fireEvent.click(await screen.findByText("Open HF output"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/hf-datasets/eliza-1-training/huggingface-dataset-manifest.json",
    );
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/hf-datasets/eliza-1-training",
    );
  });

  it("runs feed trajectory generation from the visible fine-tuning view", async () => {
    mockState();

    render(React.createElement(FineTuningView));

    const generateButton = await screen.findByText(
      "finetuningview.GenerateFeedTrajectories",
    );
    fireEvent.click(generateButton);

    await screen.findByText("/tmp/feed-generation");
    await screen.findByText("Feed artifacts");
    await screen.findByText(
      /feed_parallel_generation source:feed_train_parallel_generation trajectories:2 manifest:\/tmp\/feed-generation\/feed-parallel\.manifest\.json export:\/tmp\/feed-generation\/feed-generated-trajectories\.jsonl output:\/tmp\/feed-generation/,
    );
    expect(trainingClient.runFeedTrainingGeneration).toHaveBeenCalledWith({
      archetypes: "trader",
      numAgents: 1,
      ticks: 1,
      parallel: 1,
      cleanup: true,
      dryRun: true,
      outputDir: undefined,
    });
    fireEvent.click(await screen.findByText("Open feed output"));
    fireEvent.click(await screen.findByText("Open feed manifest"));
    fireEvent.click(await screen.findByText("Open feed export"));
    expect(openExternalUrl).toHaveBeenCalledWith("file:///tmp/feed-generation");
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/feed-generation/feed-parallel.manifest.json",
    );
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/feed-generation/feed-generated-trajectories.jsonl",
    );
  });

  it("stages the Eliza-1 bundle from the visible fine-tuning view", async () => {
    mockState();

    render(React.createElement(FineTuningView));

    fireEvent.click(await screen.findByText("finetuningview.StageEliza1Bundle"));

    expect(
      await screen.findByText("/tmp/eliza-stage/eliza1-bundle-stage-manifest.json"),
    ).toBeTruthy();
    expect(
      await screen.findByText("/tmp/eliza-1-bundles/eliza-1-0_8b.bundle"),
    ).toBeTruthy();
    expect(trainingClient.stageEliza1Bundle).toHaveBeenCalledWith({
      repoId: "elizaos/eliza-1",
      tier: "0_8b",
      localDir: "/tmp/eliza-1-bundles",
      outputDir: undefined,
      maxBytes: 8_589_934_592,
      apply: false,
    });
    fireEvent.click(await screen.findByText("Open bundle manifest"));
    fireEvent.click(await screen.findByText("Open bundle output"));
    fireEvent.click(await screen.findByText("Open bundle dir"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/eliza-stage/eliza1-bundle-stage-manifest.json",
    );
    expect(openExternalUrl).toHaveBeenCalledWith("file:///tmp/eliza-stage");
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/eliza-1-bundles/eliza-1-0_8b.bundle",
    );
  });

  it("runs scenarios from the visible fine-tuning view", async () => {
    mockState();
    trainingClient.runTrainingScenarios.mockResolvedValue({
      workspaceRoot: "/tmp/workspace",
      scenarioRunnerRoot: "/tmp/workspace/packages/scenario-runner",
      scenarioDir: "/tmp/workspace/packages/test/scenarios",
      outputDir: "/tmp/scenario-run",
      runId: "scenario-run-1",
      matrixPath: "/tmp/scenario-run/matrix.json",
      viewerHtmlPath: "/tmp/scenario-run/viewer/index.html",
      nativeJsonlPath: "/tmp/scenario-run/scenario-native.jsonl",
      nativeManifestPath: "/tmp/scenario-run/scenario-native.manifest.json",
      command: ["bun", "run", "scenario"],
      env: {},
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    render(React.createElement(FineTuningView));

    fireEvent.click(await screen.findByText("finetuningview.RunScenarios"));

    expect(
      await screen.findByText("/tmp/scenario-run/matrix.json"),
    ).toBeTruthy();
    expect(
      await screen.findByText("/tmp/scenario-run/viewer/index.html"),
    ).toBeTruthy();
    expect(
      await screen.findByText("/tmp/scenario-run/scenario-native.jsonl"),
    ).toBeTruthy();
    expect(await screen.findByText("bun run scenario")).toBeTruthy();
    fireEvent.click(await screen.findByText("Open scenario viewer"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/scenario-run/viewer/index.html",
    );
    fireEvent.click(await screen.findByText("Open scenario matrix"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/scenario-run/matrix.json",
    );
    fireEvent.click(await screen.findByText("Open native JSONL"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/scenario-run/scenario-native.jsonl",
    );
    fireEvent.click(await screen.findByText("Open scenario output"));
    expect(openExternalUrl).toHaveBeenCalledWith("file:///tmp/scenario-run");
    expect(trainingClient.runTrainingScenarios).toHaveBeenCalledWith({
      scenario: "deterministic-pr-smoke",
      outputDir: undefined,
      exportNative: true,
      useDeterministicProxy: true,
      dryRun: true,
    });
  });

  it("surfaces local eval comparison metrics in the visible fine-tuning view", async () => {
    mockState();
    trainingClient.runTrainingLocalEvalComparison.mockResolvedValue({
      outputDir: "/tmp/eval-comparison",
      artifactPath: "/tmp/eval-comparison/eval-comparison.json",
      artifact: {
        schema: "eliza_eval_comparison_artifact",
        models: {
          base: "eliza-1-0_8b-base",
          trained: "eliza-1-0_8b-trained",
          backend: "cpu",
        },
        metrics: {
          baseScore: 0.4,
          trainedScore: 0.6,
          improvementAbsolute: 0.2,
          improvementPercent: 50,
          baseLatencyMs: 120,
          trainedLatencyMs: 145,
          promptCount: 12,
        },
      },
      trainingRoot: "/repo/packages/training",
      command: ["python3", "compare_local_models.py"],
      reportPath: "/tmp/eval-comparison/local_model_comparison.json",
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    });

    render(React.createElement(FineTuningView));

    fireEvent.click(
      await screen.findByText("finetuningview.RunEvalComparison"),
    );

    expect(
      await screen.findByText("/tmp/eval-comparison/eval-comparison.json"),
    ).toBeTruthy();
    expect(await screen.findByText("Eval metrics")).toBeTruthy();
    expect(
      await screen.findByText(
        /eliza-1-0_8b-base -> eliza-1-0_8b-trained backend:cpu base:0.4 trained:0.6 improvement:50% delta:0.2 prompts:12 latency:120ms->145ms/,
      ),
    ).toBeTruthy();
    fireEvent.click(await screen.findByText("Open eval artifact"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/eval-comparison/eval-comparison.json",
    );
    fireEvent.click(await screen.findByText("Open eval report"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/eval-comparison/local_model_comparison.json",
    );
    fireEvent.click(await screen.findByText("Open eval output"));
    expect(openExternalUrl).toHaveBeenCalledWith("file:///tmp/eval-comparison");
    expect(trainingClient.runTrainingLocalEvalComparison).toHaveBeenCalledWith({
      manifestPath: undefined,
      model: "eliza-1-0_8b-base",
      trainedModelPath: "eliza-1-0_8b-trained",
      backend: "cpu",
      outputDir: undefined,
      dryRun: true,
    });
  });

  it("runs the action benchmark from the visible fine-tuning view", async () => {
    mockState();

    render(React.createElement(FineTuningView));

    const benchmarkButton = await screen.findByText(
      "finetuningview.RunActionBenchmark",
    );
    fireEvent.click(benchmarkButton);

    await screen.findByText(
      "/tmp/action-benchmark/action-benchmark-report.json",
    );
    fireEvent.click(await screen.findByText("Open action report"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/action-benchmark/action-benchmark-report.json",
    );
    fireEvent.click(await screen.findByText("Open action summary"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/action-benchmark/action-benchmark-report.md",
    );
    fireEvent.click(await screen.findByText("Open action trajectories"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/action-benchmark/trajectories",
    );
    fireEvent.click(await screen.findByText("Open action output"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/action-benchmark",
    );
    expect(trainingClient.runTrainingActionBenchmark).toHaveBeenCalledWith({
      filter: undefined,
      runsPerCase: 1,
      outputDir: undefined,
      provider: "local-llama-cpp",
      modelId: "eliza-1-0_8b-trained",
      runtimeModel: "eliza-1-0_8b-trained",
      baseUrl: "http://localhost:11434/v1",
      variant: "trained",
      tier: "0_8b",
      benchmark: "eliza_harness_action_selection",
      datasetVersion: "eliza-native-v1",
      useMocks: false,
      forceTrajectoryCapture: true,
      dryRun: true,
    });
  });

  it("runs benchmark vs Cerebras and opens saved matrix evidence from the visible fine-tuning view", async () => {
    mockState();

    render(React.createElement(FineTuningView));

    fireEvent.click(
      await screen.findByText("finetuningview.RunBenchmarkVsCerebras"),
    );

    await screen.findByText("/tmp/benchmark-matrix/benchmark-matrix.json");
    fireEvent.click(await screen.findByText("Open matrix artifact"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/benchmark-matrix/benchmark-matrix.json",
    );
    fireEvent.click(await screen.findByText("Open benchmark output"));
    expect(openExternalUrl).toHaveBeenCalledWith("file:///tmp/benchmark-run");
    expect(trainingClient.runTrainingBenchmarkVsCerebras).toHaveBeenCalledWith({
      tiers: "0_8b",
      benchmark: "eliza_harness_action_selection",
      variants: "both",
      maxSamples: 50,
      dryRun: true,
      resultsDb: undefined,
      trainedModelPath: undefined,
      matrixOutputDir: undefined,
    });
  });

  it("runs the full training collection from the visible fine-tuning view", async () => {
    mockState();

    render(React.createElement(FineTuningView));

    const sanitizedJsonlInput = await screen.findByPlaceholderText(
      "/path/to/trajectories.sanitized.jsonl",
    );
    fireEvent.change(sanitizedJsonlInput, {
      target: { value: "/tmp/app-trajectories/sanitized.jsonl" },
    });
    await waitFor(() => {
      expect(
        (
          screen.getByPlaceholderText(
            "/path/to/trajectories.sanitized.jsonl",
          ) as HTMLInputElement
        ).value,
      ).toBe("/tmp/app-trajectories/sanitized.jsonl");
    });
    const rawJsonlInput = await screen.findByPlaceholderText(
      "/path/to/trajectories.raw.jsonl",
    );
    fireEvent.change(rawJsonlInput, {
      target: { value: "/tmp/app-trajectories/raw.jsonl" },
    });
    await waitFor(() => {
      expect(
        (
          screen.getByPlaceholderText(
            "/path/to/trajectories.raw.jsonl",
          ) as HTMLInputElement
        ).value,
      ).toBe("/tmp/app-trajectories/raw.jsonl");
    });
    const collectButton = await screen.findByText(
      "finetuningview.CollectAndIndex",
    );
    fireEvent.click(collectButton);
    await waitFor(() => {
      expect(trainingClient.runTrainingCollection).toHaveBeenCalled();
    });

    expect(
      (await screen.findAllByText("/tmp/training-collection")).length,
    ).toBeGreaterThan(0);
    await screen.findByText("/tmp/training-collection/README.md");
    await screen.findByText("Saved collection runs");
    await screen.findByText("/tmp/training/collections");
    await screen.findByText(
      /2026-05-18T12:00:00.000Z partial ready:5 partial:2 missing:6/,
    );
    await screen.findByText(
      /artifacts:8 steps:9 ok\/0 failed sources hf:1 feed:1 natural:1 cases:1 comparisons:1 tiers:0_8b/,
    );
    await screen.findByText(
      /evals:2 eval-comparisons:1 eliza-1-0_8b-base->eliza-1-0_8b-trained improvement:25%/,
    );
    await screen.findByText(
      /baseline established:0_8b next:2b remaining:2b,4b,9b,27b/,
    );
    await screen.findByText(
      /models:2 training-runs:1 inventory:1 0_8b trained eliza-1-0_8b-trained base:eliza-1-0_8b-base score:0\.4->0\.5 output:hf:\/\/elizaos\/eliza-1-0_8b-trained improvement:25%/,
    );
    await screen.findByText(
      /gaps: all_eliza1_tiers_benchmark:missing->terminal-training-run-collection/,
    );
    fireEvent.click(
      await screen.findByTitle(
        "all_eliza1_tiers_benchmark: terminal-training-run-collection",
      ),
    );
    await waitFor(() => {
      expect(trainingClient.runTrainingCollection).toHaveBeenLastCalledWith(
        expect.objectContaining({
          actionBenchmarkPairs: expect.arrayContaining([
            expect.objectContaining({ tier: "0_8b" }),
            expect.objectContaining({ tier: "27b" }),
          ]),
        }),
      );
    });
    await screen.findByText(
      /coverage samples:7 hf:1 feed:1 natural:1 scenarios:1 tests:1 jsonl:2 scored-evals:1\/1 scored-bench:1\/1 all-tiers:no/,
    );
    await screen.findByText(
      /source samples: huggingFace:hf-history-traj task:response input:hf history input output:hf history output/,
    );
    await screen.findByText(
      /feed:feed-history-traj task:market_tick input:feed history input output:feed history output/,
    );
    await screen.findByText("feed:feed-history");
    fireEvent.click(await screen.findByText("training_jsonl:feed-history-trajectories.jsonl"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/training-collection/feed/feed-history-trajectories.jsonl",
    );
    await screen.findByText("benchmark:benchmark-history");
    fireEvent.click(await screen.findByText("eval:eval-history"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/training-collection/eval/eval-comparison.json",
    );
    await screen.findByText("model:eliza-1-0_8b-trained");
    fireEvent.click(await screen.findByText("Open summary"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/training-collection/README.md",
    );
    fireEvent.click(await screen.findByText("Open saved viewer"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/training-collection/analysis/index.html",
    );
    expect(trainingClient.listTrainingCollections).toHaveBeenCalledWith({
      limit: 10,
    });
    await screen.findByText("Source coverage");
    await screen.findByText(
      /^hf:1 feed:1 natural:1 scenarios:1 tests:1 jsonl:1$/,
    );
    await screen.findByText("Readable samples");
    await screen.findByText(
      /total:6 hf:1 feed:1 natural:1 scenarios:1 tests:1 jsonl:1/,
    );
    await screen.findByText(/models:2 base:1 trained:1 tiers:0_8b/);
    await screen.findByText("Benchmark model stats");
    await screen.findByText(/best:eliza-1-0_8b-trained avg:0.72/);
    await screen.findByText(
      /smallest:ready improvement:ready all-tier:missing samples:ready/,
    );
    await screen.findByText("Live preflight");
    expect(
      await screen.findAllByText(
        /live:yes app_core_action_benchmark:ok->\/workspace\/eliza\/packages\/app-core\/test\/benchmarks\/action-selection\.real\.test\.ts \| action_benchmark_provider:warning \| cerebras_api_key:missing/,
      ),
    ).toHaveLength(2);
    expect(await screen.findAllByText(/action_benchmark_endpoint:ok/)).toHaveLength(
      2,
    );
    await screen.findByText("Analysis benchmark improvement");
    await screen.findByText("Feed generation evidence");
    await screen.findByText("Step artifact outputs");
    await screen.findByText(
      /action_benchmark:reportJsonPath->\/tmp\/action\/action-benchmark-report\.json cmd:bun run test test\/benchmarks\/action-selection\.real\.test\.ts/,
    );
    await screen.findByText(
      /feed_train_parallel_generation trader trajectories:4 ticks:12 errors:0 -> \/tmp\/feed\.json/,
    );
    await screen.findByText("Feed trajectory samples");
    await screen.findByText(
      /feed-traj-1 trader scenario:multi-archetype-trader score:0.87 steps:1 first:BUY/,
    );
    await screen.findByText(
      /feed:feed-traj-1 task:n\/a model:n\/a input:BUY output:profitable and coherent/,
    );
    await screen.findByText("Eval comparison evidence");
    await screen.findByText(
      /eliza-1-0_8b-base -> eliza-1-0_8b-trained backend:cpu base:0.4 trained:0.5 improvement:25% latency:120ms->150ms report:\/tmp\/eval\/local_model_comparison\.json/,
    );
    await screen.findByText("Baseline progression");
    await screen.findByText(
      /order:0_8b -> 2b -> 4b -> 9b -> 27b established:0_8b next:2b remaining:2b,4b,9b,27b/,
    );
    await screen.findByText("Benchmark case samples");
    await screen.findByText(
      /0_8b trained message-route pass:true input:send David the update expected:MESSAGE actual:MESSAGE output:Message queued for David\./,
    );
    await screen.findByText(
      /0_8b eliza_harness_action_selection base:0.4 trained:0.5 reference:0.8 improvement:25% vs-ref:-37.5%/,
    );
    expect(trainingClient.runTrainingCollection).toHaveBeenCalledWith({
      preflightOnly: false,
      preflightProbe: true,
      includeHuggingFace: true,
      includeFeed: true,
      includeNaturalTrajectories: true,
      includeTestTrajectories: true,
      includeScenarios: true,
      includeEvalComparison: true,
      includeActionBenchmark: true,
      includeBenchmarkVsCerebras: true,
      includeEliza1ModelRegistry: true,
      includeEliza1BundleStage: true,
      includeBenchmarkMatrix: true,
      huggingFace: {
        repoId: "elizaos/eliza-1-training",
        revision: "main",
        files: DEFAULT_ELIZA1_HF_DATASET_FILES,
        dryRun: true,
        outputDir: undefined,
      },
      feed: {
        archetypes: "trader",
        numAgents: 1,
        ticks: 1,
        parallel: 1,
        cleanup: true,
        dryRun: true,
        outputDir: undefined,
      },
      naturalTrajectories: {
        sanitizedJsonlPath: "/tmp/app-trajectories/sanitized.jsonl",
        rawJsonlPath: "/tmp/app-trajectories/raw.jsonl",
        includeRawJsonl: true,
        tasks: ["response", "action_planner"],
        source: {
          kind: "training_collection_natural_trajectories",
          runId: undefined,
          metadata: {
            ui: true,
            sanitizedJsonlPath: "/tmp/app-trajectories/sanitized.jsonl",
            rawJsonlPath: "/tmp/app-trajectories/raw.jsonl",
          },
        },
      },
      scenarios: {
        dryRun: true,
        scenario: "deterministic-pr-smoke",
        outputDir: undefined,
        exportNative: true,
        useDeterministicProxy: true,
      },
      evalComparison: {
        manifestPath: undefined,
        model: "eliza-1-0_8b-base",
        trainedModelPath: "eliza-1-0_8b-trained",
        backend: "cpu",
        outputDir: undefined,
        dryRun: true,
      },
      actionBenchmark: {
        filter: undefined,
        runsPerCase: 1,
        outputDir: undefined,
        provider: "local-llama-cpp",
        modelId: "eliza-1-0_8b-trained",
        runtimeModel: "eliza-1-0_8b-trained",
        baseUrl: "http://localhost:11434/v1",
        variant: "trained",
        tier: "0_8b",
        benchmark: "eliza_harness_action_selection",
        datasetVersion: "eliza-native-v1",
        useMocks: false,
        forceTrajectoryCapture: true,
        dryRun: true,
      },
      actionBenchmarkPair: {
        tier: "0_8b",
        base: {
          modelId: "eliza-1-0_8b-base",
          runtimeModel: "eliza-1-0_8b-base",
          variant: "base",
        },
        trained: {
          modelId: "eliza-1-0_8b-trained",
          runtimeModel: "eliza-1-0_8b-trained",
          variant: "trained",
        },
      },
      actionBenchmarkPairs: undefined,
      benchmarkVsCerebras: {
        tiers: "0_8b",
        benchmark: "eliza_harness_action_selection",
        variants: "both",
        maxSamples: 50,
        dryRun: true,
        resultsDb: undefined,
        trainedModelPath: undefined,
        matrixOutputDir: undefined,
      },
      eliza1BundleStage: {
        repoId: "elizaos/eliza-1",
        tier: "0_8b",
        localDir: "/tmp/eliza-1-bundles",
        outputDir: undefined,
        maxBytes: 8589934592,
        apply: false,
      },
    });
    await screen.findByText(
      /hf:1 feed:1 natural:1 scenarios:1 native:1 tests:1 jsonl:2/,
    );
    expect(
      await screen.findByText(
        /smallest:ready improvement:ready all-tier:missing/,
      ),
    ).toBeTruthy();
    expect(
      await screen.findByText(/pairs:1\s+sources:2\s+rows:3\s+comparisons:1/),
    ).toBeTruthy();
    expect(await screen.findByText("Evidence artifacts")).toBeTruthy();
    expect(
      await screen.findByText(/huggingface:hf -> \/tmp\/hf\.json/),
    ).toBeTruthy();
    expect((await screen.findAllByText("0_8b")).length).toBeGreaterThan(0);
    expect(
      await screen.findByText(
        /0_8b eliza_harness_action_selection base:0.4 trained:0.5 improvement:25%/,
      ),
    ).toBeTruthy();
    expect(
      await screen.findByText(
        /all_eliza1_tiers_benchmark:missing -> terminal-training-run-collection/,
      ),
    ).toBeTruthy();
  });

  it("runs collection preflight from the visible fine-tuning view", async () => {
    mockState();
    trainingClient.runTrainingCollection.mockResolvedValueOnce({
      preflight: sampleCollectionRun.manifest.evidence.preflight,
    });

    render(React.createElement(FineTuningView));

    fireEvent.click(await screen.findByText("Run collection preflight"));

    await screen.findByText("Collection preflight");
    await screen.findByText(/action_benchmark_endpoint:ok/);
    expect(trainingClient.runTrainingCollection).toHaveBeenCalledWith(
      expect.objectContaining({
        preflightOnly: true,
        preflightProbe: true,
      }),
    );
  });

  it("runs a readiness recommendation from the visible fine-tuning view", async () => {
    mockState();

    render(React.createElement(FineTuningView));

    const readinessButton = await screen.findByText(
      "finetuningview.BuildReadinessReport",
    );
    fireEvent.click(readinessButton);

    await screen.findByText("All Eliza-1 tier benchmark coverage · missing");
    fireEvent.click(await screen.findByText("Open readiness report"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/training-analysis/training-readiness-report.json",
    );
    fireEvent.click(await screen.findByText("Open readiness viewer"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/training-analysis/index.html",
    );
    fireEvent.click(await screen.findByText("Open readiness output"));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "file:///tmp/training-analysis",
    );
    const recommendationButton = await screen.findByText("Run recommendation");
    fireEvent.click(recommendationButton);

    expect(
      (await screen.findAllByText("/tmp/training-collection")).length,
    ).toBeGreaterThan(0);
    expect(trainingClient.runTrainingCollection).toHaveBeenCalledWith(
      expect.objectContaining({
        includeActionBenchmark: true,
        includeBenchmarkMatrix: true,
        actionBenchmarkPairs: [
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
        ],
      }),
    );
    expect(trainingClient.buildTrainingReadinessReport).toHaveBeenCalledTimes(
      2,
    );
  });

  it("surfaces scenario readiness recommendation results in the visible fine-tuning view", async () => {
    mockState();
    trainingClient.buildTrainingReadinessReport.mockResolvedValue({
      outputDir: "/tmp/training-analysis",
      reportPath: "/tmp/training-analysis/training-readiness-report.json",
      report: {
        ...sampleReadinessReport.report,
        counts: { checks: 1, ready: 0, partial: 0, missing: 1, artifacts: 0 },
        checks: [
          {
            id: "scenario_trajectories",
            label: "Scenario trajectories",
            status: "missing",
            artifactCount: 0,
            artifactPaths: [],
            note: "No scenario run or native scenario export was found.",
            recommendedAction: {
              label: "Run scenarios with native trajectory export",
              capability: "terminal-training-run-scenarios",
              params: {
                dryRun: true,
                exportNative: true,
                useDeterministicProxy: true,
              },
            },
          },
        ],
      },
    });
    trainingClient.runTrainingScenarios.mockResolvedValue({
      workspaceRoot: "/tmp/workspace",
      scenarioRunnerRoot: "/tmp/workspace/packages/scenario-runner",
      scenarioDir: "/tmp/workspace/packages/test/scenarios",
      outputDir: "/tmp/scenario-run",
      runId: "scenario-run-1",
      matrixPath: "/tmp/scenario-run/matrix.json",
      viewerHtmlPath: "/tmp/scenario-run/viewer/index.html",
      nativeJsonlPath: "/tmp/scenario-run/scenario-native.jsonl",
      nativeManifestPath: "/tmp/scenario-run/scenario-native.manifest.json",
      command: ["bun", "run", "scenario"],
      env: {},
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    render(React.createElement(FineTuningView));

    const readinessButton = await screen.findByText(
      "finetuningview.BuildReadinessReport",
    );
    fireEvent.click(readinessButton);

    await screen.findByText("Scenario trajectories · missing");
    fireEvent.click(await screen.findByText("Run recommendation"));

    expect(
      await screen.findByText("/tmp/scenario-run/matrix.json"),
    ).toBeTruthy();
    expect(
      await screen.findByText("/tmp/scenario-run/viewer/index.html"),
    ).toBeTruthy();
    expect(
      await screen.findByText("/tmp/scenario-run/scenario-native.jsonl"),
    ).toBeTruthy();
    expect(await screen.findByText("bun run scenario")).toBeTruthy();
    expect(trainingClient.runTrainingScenarios).toHaveBeenCalledWith({
      dryRun: true,
      exportNative: true,
      useDeterministicProxy: true,
    });
    expect(trainingClient.buildTrainingReadinessReport).toHaveBeenCalledTimes(
      2,
    );
  });

  it("mounts training state and exposes TUI metadata", async () => {
    mockState();

    const { container } = render(React.createElement(FineTuningTuiView));

    await screen.findByText(/trajectory-1 calls 3 reward 0.9/);
    expect(screen.getByText(/job-1/)).toBeTruthy();
    expect(
      screen.getByText(/model-1 cpu active ollama eliza-model/),
    ).toBeTruthy();
    expect(trainingClient.listTrainingJobs).toHaveBeenCalled();
    expect(screen.getByText(/run-benchmark-vs-cerebras/)).toBeTruthy();
    expect(screen.getByText(/stage-eliza1-bundle/)).toBeTruthy();

    const stateElement = container.querySelector("[data-view-state]");
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toMatchObject({
      viewType: "tui",
      viewId: "training",
      runtimeAvailable: true,
      runningJobs: 1,
      queuedJobs: 1,
      datasetCount: 1,
      jobCount: 1,
      modelCount: 1,
      trajectoryCount: 1,
    });
  });

  it("supports terminal training capabilities", async () => {
    mockState();

    await expect(interact("terminal-training-state")).resolves.toMatchObject({
      viewType: "tui",
      status: sampleStatus,
      datasets: { datasets: [sampleDataset] },
      jobs: { jobs: [sampleJob] },
      models: { models: [sampleModel] },
    });

    await expect(
      interact("terminal-training-trajectory", {
        trajectoryId: "trajectory-1",
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      trajectory: { trajectoryId: "trajectory-1" },
    });

    await expect(
      interact("terminal-training-build-dataset", {
        limit: 10,
        minLlmCallsPerTrajectory: 1,
      }),
    ).resolves.toMatchObject({ viewType: "tui", dataset: sampleDataset });

    await expect(
      interact("terminal-training-start-job", {
        datasetId: "dataset-1",
        backend: "cpu",
        iterations: 5,
      }),
    ).resolves.toMatchObject({ viewType: "tui", job: sampleJob });

    await expect(
      interact("terminal-training-cancel-job", { jobId: "job-1" }),
    ).resolves.toEqual({ viewType: "tui", ok: true });

    await expect(
      interact("terminal-training-import-model", {
        modelId: "model-1",
        modelName: "eliza-model",
      }),
    ).resolves.toMatchObject({ viewType: "tui", model: sampleModel });

    await expect(
      interact("terminal-training-activate-model", {
        modelId: "model-1",
        providerModel: "ollama/eliza-model",
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      modelId: "model-1",
      providerModel: "ollama/eliza-model",
    });

    await expect(
      interact("terminal-training-benchmark-model", { modelId: "model-1" }),
    ).resolves.toEqual({ viewType: "tui", status: "passed" });

    await expect(
      interact("terminal-training-build-analysis-index", {
        roots: ["/tmp"],
        outputDir: "/tmp/training-analysis",
        maxDepth: 3,
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      indexHtmlPath: "/tmp/training-analysis/index.html",
      manifest: { counts: { artifacts: 9 } },
    });

    await expect(
      interact("terminal-training-build-readiness-report", {
        roots: ["/tmp"],
        outputDir: "/tmp/training-analysis",
        reportOutputDir: "/tmp/training-analysis",
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      reportPath: "/tmp/training-analysis/training-readiness-report.json",
      report: { status: "partial", counts: { missing: 4 } },
    });

    await expect(
      interact("terminal-training-ingest-hf-dataset", {
        repoId: "elizaos/eliza-1-training",
        files: ["sft/0_8b/train.jsonl"],
        dryRun: true,
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      manifest: {
        schema: "eliza_huggingface_dataset_ingest",
        source: { repoId: "elizaos/eliza-1-training" },
      },
    });

    await expect(
      interact("terminal-training-feed-generate", {
        archetypes: "trader",
        numAgents: 1,
        ticks: 1,
        parallel: 1,
        dryRun: true,
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      outputDir: "/tmp/feed-generation",
      exitCode: 0,
    });

    await expect(
      interact("terminal-training-write-benchmark-matrix", {
        rows: [
          {
            modelId: "cerebras/gpt-oss-120b",
            variant: "reference",
            benchmark: "eliza_harness_action_reason",
            score: 0.8,
          },
        ],
        referenceModelId: "cerebras/gpt-oss-120b",
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      artifactPath: "/tmp/benchmark-matrix/benchmark-matrix.json",
    });

    await expect(
      interact("terminal-training-run-benchmark-vs-cerebras", {
        tiers: "0_8b,2b,4b,9b,27b",
        benchmark: "eliza_harness_action_selection",
        maxSamples: 1,
        dryRun: true,
        resultsDb: "/tmp/results.db",
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      outputDir: "/tmp/benchmark-run",
      matrixOutputDir: "/tmp/benchmark-matrix",
      exitCode: 0,
    });

    await expect(
      interact("terminal-training-stage-eliza1-bundle", {
        tier: "0_8b",
        localDir: "/tmp/eliza-1-bundles",
        maxBytes: 2_000_000_000,
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      plan: {
        bundleDir: "/tmp/eliza-1-bundles/eliza-1-0_8b.bundle",
        apply: false,
      },
      exitCode: 0,
    });

    await expect(
      interact("terminal-training-run-collection", {
        preflightOnly: true,
        preflightProbe: true,
        includeActionBenchmark: true,
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      outputDir: "/tmp/training-collection",
    });
    expect(trainingClient.runTrainingCollection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        preflightOnly: true,
        preflightProbe: true,
        includeActionBenchmark: true,
      }),
    );

    await expect(
      interact("terminal-training-run-action-benchmark", {
        filter: "message-route",
        runsPerCase: 1,
        dryRun: true,
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      outputDir: "/tmp/action-benchmark",
      reportJsonPath: "/tmp/action-benchmark/action-benchmark-report.json",
      exitCode: 0,
    });
  });

  it("preserves explicit mocked action benchmark requests from terminal capabilities", async () => {
    mockState();

    await expect(
      interact("terminal-training-run-action-benchmark", {
        filter: "message-route",
        dryRun: false,
        useMocks: true,
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      reportJsonPath: "/tmp/action-benchmark/action-benchmark-report.json",
    });

    expect(trainingClient.runTrainingActionBenchmark).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: "message-route",
        dryRun: false,
        useMocks: true,
      }),
    );
  });

  it("can execute every readiness recommendation capability", async () => {
    mockState();
    trainingClient.runTrainingScenarios.mockResolvedValue({
      outputDir: "/tmp/scenario-run",
      matrixPath: "/tmp/scenario-run/matrix.json",
      exitCode: 0,
    });
    trainingClient.runTrainingLocalEvalComparison.mockResolvedValue({
      outputDir: "/tmp/eval-comparison",
      artifactPath: "/tmp/eval-comparison/eval-comparison.json",
    });
    const report = buildTrainingReadinessReportPayload(emptyAnalysisIndex(), {
      generatedAt: "2026-01-02T03:04:05.000Z",
    });
    const actions = [
      ...new Map(
        report.checks
          .map((check) => check.recommendedAction)
          .filter((action): action is NonNullable<typeof action> =>
            Boolean(action),
          )
          .map((action) => [action.capability, action]),
      ).values(),
    ];

    expect(actions.map((action) => action.capability).sort()).toEqual([
      "terminal-training-build-analysis-index",
      "terminal-training-feed-generate",
      "terminal-training-ingest-hf-dataset",
      "terminal-training-run-benchmark-vs-cerebras",
      "terminal-training-run-collection",
      "terminal-training-run-scenarios",
      "terminal-training-stage-eliza1-bundle",
    ]);
    for (const action of actions) {
      await expect(
        interact(action.capability, action.params),
      ).resolves.toMatchObject({ viewType: "tui" });
    }
  });
});
