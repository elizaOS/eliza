/**
 * Orchestrates the full training-data collection pipeline end to end:
 * HuggingFace dataset ingest, feed generation, scenario runs, and action
 * benchmarks, writing each stage's artifact plus a schema-tagged run summary
 * and collection index. This is the top-level entry the CLI and auto-train
 * trigger call to assemble a training corpus.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Trajectory } from "@elizaos/agent";
import { toLocalFileUrl } from "../util/local-file-url.js";
import {
  type ActionBenchmarkRunOptions,
  type ActionBenchmarkRunResult,
  runActionBenchmark,
} from "./action-benchmark-runner.js";
import {
  type BenchmarkMatrixArtifactResult,
  type BenchmarkMatrixArtifactSource,
  writeBenchmarkMatrixArtifactFromArtifacts,
} from "./benchmark-matrix-artifact.js";
import {
  type BenchmarkVsCerebrasRunOptions,
  type BenchmarkVsCerebrasRunResult,
  runBenchmarkVsCerebras,
} from "./benchmark-vs-cerebras-runner.js";
import {
  canonicalElizaOneTierSort,
  ELIZA_ONE_BENCHMARK_TIERS,
  elizaOneActionBenchmarkPairs,
  elizaOneBenchmarkModelId,
  parseElizaOneBenchmarkTiers,
} from "./eliza1-benchmark-recipe.js";
import {
  type StageEliza1BundleOptions,
  type StageEliza1BundleResult,
  stageEliza1Bundle,
} from "./eliza1-bundle-stager.js";
import {
  EVAL_COMPARISON_ARTIFACT_SCHEMA,
  type EvalComparisonRunOptions,
  type EvalComparisonRunResult,
  runLocalEvalComparison,
} from "./eval-comparison-artifact.js";
import {
  type FeedGenerationRunOptions,
  type FeedGenerationRunResult,
  runFeedGeneration,
} from "./feed-generation-runner.js";
import {
  type HuggingFaceDatasetIngestResult,
  type IngestHuggingFaceDatasetOptions,
  ingestHuggingFaceDataset,
} from "./huggingface-dataset-ingest.js";
import {
  runScenarios,
  type ScenarioRunOptions,
  type ScenarioRunResult,
} from "./scenario-runner.js";
import {
  type CollectTestTrajectoriesOptions,
  collectTestTrajectories,
  type TestTrajectoryCollectionResult,
} from "./test-trajectory-collector.js";
import {
  type BuildTrainingAnalysisIndexOptions,
  buildTrainingAnalysisIndex,
  type TrainingAnalysisIndex,
} from "./training-analysis-index.js";
import { trainingStateRoot } from "./training-config.js";
import {
  type TrainingReadinessReport,
  writeTrainingReadinessReport,
} from "./training-readiness-report.js";
import {
  type BuildTrajectoryExportBundleOptions,
  buildTrajectoryExportBundle,
  type TrajectoryExportBundle,
} from "./trajectory-export-bundle.js";
import { discoverWorkspaceRoot } from "./workspace-runtime.js";

export const TRAINING_COLLECTION_RUN_SCHEMA = "eliza_training_collection_run";
export const TRAINING_COLLECTION_RUN_VERSION = 1;
export const TRAINING_COLLECTION_INDEX_SCHEMA =
  "eliza_training_collection_index";
export const TRAINING_COLLECTION_INDEX_VERSION = 1;

export interface TrainingCollectionRunOptions {
  preflightOnly?: boolean;
  preflightProbe?: boolean;
  outputDir?: string;
  workspaceRoot?: string;
  includeHuggingFace?: boolean;
  includeFeed?: boolean;
  includeNaturalTrajectories?: boolean;
  includeTestTrajectories?: boolean;
  includeScenarios?: boolean;
  includeEvalComparison?: boolean;
  includeActionBenchmark?: boolean;
  includeBenchmarkVsCerebras?: boolean;
  includeEliza1ModelRegistry?: boolean;
  includeEliza1BundleStage?: boolean;
  includeBenchmarkMatrix?: boolean;
  huggingFace?: IngestHuggingFaceDatasetOptions;
  feed?: FeedGenerationRunOptions;
  naturalTrajectories?: Omit<
    BuildTrajectoryExportBundleOptions,
    "outputDir"
  > & {
    outputDir?: string;
    trajectories?: Trajectory[];
  };
  testTrajectories?: CollectTestTrajectoriesOptions;
  scenarios?: ScenarioRunOptions;
  evalComparison?: EvalComparisonRunOptions;
  actionBenchmark?: ActionBenchmarkRunOptions;
  actionBenchmarkPair?: ActionBenchmarkPairOptions;
  actionBenchmarkPairs?: ActionBenchmarkPairOptions[] | string;
  benchmarkVsCerebras?: BenchmarkVsCerebrasRunOptions;
  eliza1BundleStage?: StageEliza1BundleOptions;
  benchmarkMatrix?: {
    artifacts?: BenchmarkMatrixArtifactSource[];
    outputDir?: string;
    generatedAt?: string;
    referenceModelId?: string;
    source?: Record<string, unknown>;
  };
  analysis?: Omit<BuildTrainingAnalysisIndexOptions, "roots" | "outputDir"> & {
    roots?: string[];
    outputDir?: string;
  };
  now?: () => Date;
}

export interface ActionBenchmarkPairOptions {
  label?: string;
  tier?: string;
  base?: ActionBenchmarkRunOptions;
  trained?: ActionBenchmarkRunOptions;
}

export interface ActionBenchmarkPairRunRecord {
  label: string;
  tier: string | null;
  runs: {
    base: ActionBenchmarkRunResult | null;
    trained: ActionBenchmarkRunResult | null;
  };
  matrixSources: BenchmarkMatrixArtifactSource[];
}

export interface ActionBenchmarkPairRunResult {
  outputDir: string;
  pairs: ActionBenchmarkPairRunRecord[];
  runs: {
    base: ActionBenchmarkRunResult | null;
    trained: ActionBenchmarkRunResult | null;
  };
  matrixSources: BenchmarkMatrixArtifactSource[];
}

const DEFAULT_ACTION_BENCHMARK_PAIR_TIER = "2b";

export interface TrainingCollectionStep<T = unknown> {
  id:
    | "huggingface"
    | "feed"
    | "natural_trajectories"
    | "test_trajectories"
    | "scenarios"
    | "eval_comparison"
    | "action_benchmark"
    | "benchmark_vs_cerebras"
    | "eliza1_model_registry"
    | "eliza1_bundle_stage"
    | "benchmark_matrix";
  status: "skipped" | "succeeded" | "failed";
  outputDir: string | null;
  error: string | null;
  result: T | null;
}

function resultRecord(step: TrainingCollectionStep): Record<string, unknown> {
  return step.result &&
    typeof step.result === "object" &&
    !Array.isArray(step.result)
    ? (step.result as Record<string, unknown>)
    : {};
}

function autoBenchmarkMatrixSources(
  steps: readonly TrainingCollectionStep[],
  explicit: readonly BenchmarkMatrixArtifactSource[] = [],
): BenchmarkMatrixArtifactSource[] {
  const sources: BenchmarkMatrixArtifactSource[] = [...explicit];
  for (const step of steps) {
    if (step.status !== "succeeded") continue;
    const result = resultRecord(step);
    if (
      step.id === "eval_comparison" &&
      typeof result.artifactPath === "string"
    ) {
      sources.push({ path: result.artifactPath });
    }
    if (
      step.id === "benchmark_vs_cerebras" &&
      typeof result.matrixArtifactPath === "string" &&
      existsSync(result.matrixArtifactPath)
    ) {
      sources.push({ path: result.matrixArtifactPath });
    }
    if (step.id === "action_benchmark" && Array.isArray(result.matrixSources)) {
      for (const matrixSource of result.matrixSources) {
        if (
          matrixSource &&
          typeof matrixSource === "object" &&
          !Array.isArray(matrixSource) &&
          typeof (matrixSource as Record<string, unknown>).path === "string" &&
          existsSync(
            (matrixSource as Record<string, unknown>).path as string,
          ) &&
          !sources.some(
            (source) =>
              source.path ===
              ((matrixSource as Record<string, unknown>).path as string),
          )
        ) {
          sources.push(matrixSource as BenchmarkMatrixArtifactSource);
        }
      }
    }
    if (
      step.id === "action_benchmark" &&
      result.matrixSource &&
      typeof result.matrixSource === "object" &&
      !Array.isArray(result.matrixSource) &&
      typeof (result.matrixSource as Record<string, unknown>).path ===
        "string" &&
      existsSync(
        (result.matrixSource as Record<string, unknown>).path as string,
      ) &&
      !sources.some(
        (source) =>
          source.path ===
          ((result.matrixSource as Record<string, unknown>).path as string),
      )
    ) {
      sources.push(result.matrixSource as BenchmarkMatrixArtifactSource);
    }
  }
  return sources.filter(
    (source, index, all) =>
      all.findIndex((candidate) => candidate.path === source.path) === index,
  );
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function actionBenchmarkPairLabel(
  pair: ActionBenchmarkPairOptions,
  index: number,
): string {
  return (
    safePathPart(pair.label?.trim() || pair.tier?.trim() || "") ||
    `pair-${index + 1}`
  );
}

function explicitActionBenchmarkPairs(
  options: TrainingCollectionRunOptions,
): ActionBenchmarkPairOptions[] {
  const pairs = actionBenchmarkPairsOption(options.actionBenchmarkPairs);
  if (pairs.length > 0) return pairs;
  return options.actionBenchmarkPair ? [options.actionBenchmarkPair] : [];
}

function actionBenchmarkPairsOption(
  value: TrainingCollectionRunOptions["actionBenchmarkPairs"],
): ActionBenchmarkPairOptions[] {
  if (typeof value === "string") {
    return elizaOneActionBenchmarkPairs(parseElizaOneBenchmarkTiers(value, []));
  }
  if (value && value.length > 0) {
    return value;
  }
  return [];
}

function shouldUseDefaultActionBenchmarkPair(
  options: TrainingCollectionRunOptions,
): boolean {
  if (!boolWithDefault(options.includeActionBenchmark, true)) return false;
  if (!boolWithDefault(options.includeBenchmarkMatrix, true)) return false;
  if (explicitActionBenchmarkPairs(options).length > 0) return false;

  const actionBenchmark = options.actionBenchmark;
  return !(
    actionBenchmark?.variant ||
    actionBenchmark?.modelId?.trim() ||
    actionBenchmark?.runtimeModel?.trim()
  );
}

function defaultActionBenchmarkPair(
  options: TrainingCollectionRunOptions,
): ActionBenchmarkPairOptions {
  const tier =
    options.actionBenchmark?.tier?.trim() || DEFAULT_ACTION_BENCHMARK_PAIR_TIER;
  return {
    tier,
    base: { variant: "base" },
    trained: { variant: "trained" },
  };
}

function effectiveActionBenchmarkPairs(
  options: TrainingCollectionRunOptions,
): ActionBenchmarkPairOptions[] {
  const explicit = explicitActionBenchmarkPairs(options);
  if (explicit.length > 0) return explicit;
  return shouldUseDefaultActionBenchmarkPair(options)
    ? [defaultActionBenchmarkPair(options)]
    : [];
}

async function runActionBenchmarkPair(input: {
  outputDir: string;
  workspaceRoot?: string;
  common?: ActionBenchmarkRunOptions;
  pair: ActionBenchmarkPairOptions;
  label: string;
  preserveSinglePairLayout?: boolean;
}): Promise<ActionBenchmarkPairRunRecord> {
  const { common, outputDir, workspaceRoot, pair, label } = input;
  const tier = pair.tier?.trim() || common?.tier;
  const baseOutputDir =
    pair.base?.outputDir ??
    (input.preserveSinglePairLayout
      ? join(outputDir, "base")
      : join(outputDir, label, "base"));
  const trainedOutputDir =
    pair.trained?.outputDir ??
    (input.preserveSinglePairLayout
      ? join(outputDir, "trained")
      : join(outputDir, label, "trained"));
  const base = pair.base
    ? await runActionBenchmark({
        ...(common ?? {}),
        ...pair.base,
        workspaceRoot:
          pair.base.workspaceRoot ?? common?.workspaceRoot ?? workspaceRoot,
        outputDir: baseOutputDir,
        modelId:
          pair.base.modelId ??
          elizaOneBenchmarkModelId(tier, "base") ??
          common?.modelId,
        runtimeModel:
          pair.base.runtimeModel ??
          elizaOneBenchmarkModelId(tier, "base") ??
          common?.runtimeModel,
        tier: pair.base.tier ?? tier,
        variant: pair.base.variant ?? "base",
      })
    : null;
  const trained = pair.trained
    ? await runActionBenchmark({
        ...(common ?? {}),
        ...pair.trained,
        workspaceRoot:
          pair.trained.workspaceRoot ?? common?.workspaceRoot ?? workspaceRoot,
        outputDir: trainedOutputDir,
        modelId:
          pair.trained.modelId ??
          elizaOneBenchmarkModelId(tier, "trained") ??
          common?.modelId,
        runtimeModel:
          pair.trained.runtimeModel ??
          elizaOneBenchmarkModelId(tier, "trained") ??
          common?.runtimeModel,
        tier: pair.trained.tier ?? tier,
        variant: pair.trained.variant ?? "trained",
      })
    : null;
  return {
    label,
    tier: tier ?? null,
    runs: { base, trained },
    matrixSources: [base?.matrixSource, trained?.matrixSource].filter(
      (source): source is BenchmarkMatrixArtifactSource => source != null,
    ),
  };
}

async function runActionBenchmarkCollectionStep(input: {
  outputDir: string;
  workspaceRoot?: string;
  options: TrainingCollectionRunOptions;
}): Promise<ActionBenchmarkRunResult | ActionBenchmarkPairRunResult> {
  const { outputDir, workspaceRoot, options } = input;
  const explicitPairs = actionBenchmarkPairsOption(
    options.actionBenchmarkPairs,
  );
  if (explicitPairs.length > 0) {
    const pairs: ActionBenchmarkPairRunRecord[] = [];
    for (const [index, pair] of explicitPairs.entries()) {
      pairs.push(
        await runActionBenchmarkPair({
          outputDir,
          workspaceRoot,
          common: options.actionBenchmark,
          pair: {
            ...pair,
            base: pair.base ?? {},
            trained: pair.trained ?? {},
          },
          label: actionBenchmarkPairLabel(pair, index),
        }),
      );
    }
    return {
      outputDir,
      pairs,
      runs: pairs[0]?.runs ?? { base: null, trained: null },
      matrixSources: pairs.flatMap((pair) => pair.matrixSources),
    };
  }
  const actionBenchmarkPairs = effectiveActionBenchmarkPairs(options);
  if (actionBenchmarkPairs.length === 1) {
    const actionBenchmarkPair = actionBenchmarkPairs[0];
    const pair = await runActionBenchmarkPair({
      outputDir,
      workspaceRoot,
      common: options.actionBenchmark,
      pair: {
        ...actionBenchmarkPair,
        base: actionBenchmarkPair.base ?? {},
        trained: actionBenchmarkPair.trained ?? {},
      },
      label: actionBenchmarkPairLabel(actionBenchmarkPair, 0),
      preserveSinglePairLayout: true,
    });
    return {
      outputDir,
      pairs: [pair],
      runs: pair.runs,
      matrixSources: pair.matrixSources,
    };
  }
  return runActionBenchmark({
    ...(options.actionBenchmark ?? {}),
    workspaceRoot: options.actionBenchmark?.workspaceRoot ?? workspaceRoot,
    outputDir: options.actionBenchmark?.outputDir ?? outputDir,
  });
}

export interface TrainingCollectionRunManifest {
  schema: typeof TRAINING_COLLECTION_RUN_SCHEMA;
  schemaVersion: typeof TRAINING_COLLECTION_RUN_VERSION;
  generatedAt: string;
  outputDir: string;
  manifestPath: string;
  readmePath: string;
  provenance: TrainingCollectionRunProvenance;
  recipe: TrainingCollectionRecipe;
  analysis: {
    outputDir: string;
    indexHtmlPath: string;
    manifestPath: string;
    artifactCount: number;
  };
  readiness: {
    outputDir: string;
    reportPath: string;
    status: TrainingReadinessReport["status"];
    ready: number;
    partial: number;
    missing: number;
  };
  evidence: TrainingCollectionEvidenceSummary;
  steps: TrainingCollectionStep[];
}

export interface TrainingCollectionRunProvenance {
  generatedBy: "plugin-training";
  workspaceRoot: string | null;
  trainingStateRoot: string;
  analysisRoots: string[];
  outputLayout: {
    collection: string;
    analysis: string;
    steps: string;
  };
}

export interface TrainingCollectionRecipe {
  include: {
    huggingFace: boolean;
    feed: boolean;
    naturalTrajectories: boolean;
    testTrajectories: boolean;
    scenarios: boolean;
    evalComparison: boolean;
    actionBenchmark: boolean;
    benchmarkVsCerebras: boolean;
    eliza1ModelRegistry: boolean;
    eliza1BundleStage: boolean;
    benchmarkMatrix: boolean;
  };
  sources: {
    huggingFace: Record<string, unknown>;
    feed: Record<string, unknown>;
    naturalTrajectories: Record<string, unknown>;
    testTrajectories: Record<string, unknown>;
    scenarios: Record<string, unknown>;
  };
  evals: {
    evalComparison: Record<string, unknown>;
    actionBenchmark: Record<string, unknown>;
    actionBenchmarkPair: Record<string, unknown> | null;
    actionBenchmarkPairs: Record<string, unknown>[];
    benchmarkVsCerebras: Record<string, unknown>;
    benchmarkMatrix: Record<string, unknown>;
  };
  training: {
    eliza1ModelRegistry: Record<string, unknown>;
    eliza1BundleStage: Record<string, unknown>;
  };
}

export interface TrainingCollectionRunResult {
  outputDir: string;
  manifestPath: string;
  readmePath: string;
  collectionIndex: TrainingCollectionIndex;
  manifest: TrainingCollectionRunManifest;
  analysis: TrainingAnalysisIndex;
}

export interface ListTrainingCollectionsOptions {
  root?: string;
  limit?: number;
}

export interface TrainingCollectionRunSummary {
  generatedAt: string;
  outputDir: string;
  manifestPath: string;
  readmePath: string;
  analysisIndexHtmlPath: string;
  readinessStatus: TrainingReadinessReport["status"];
  readiness: {
    ready: number;
    partial: number;
    missing: number;
  };
  readinessGaps: TrainingCollectionEvidenceSummary["readinessGaps"];
  artifactCount: number;
  stepCounts: Record<TrainingCollectionStep["status"], number>;
  dataSources: TrainingCollectionEvidenceSummary["dataSources"];
  sourceSamples: {
    huggingFace: TrainingCollectionSourceSample[];
    feed: TrainingCollectionSourceSample[];
    natural: TrainingCollectionSourceSample[];
    scenarios: TrainingCollectionSourceSample[];
    tests: TrainingCollectionSourceSample[];
    trainingJsonl: TrainingCollectionSourceSample[];
  };
  sourceArtifacts: Array<{
    category:
      | "huggingface"
      | "feed"
      | "natural"
      | "scenario"
      | "test"
      | "training_jsonl";
    title: string;
    path: string;
    schema: string | null;
  }>;
  evidenceArtifacts: Array<{
    category: "eval" | "benchmark" | "model";
    title: string;
    path: string;
    schema: string | null;
  }>;
  training: {
    trainingRuns: number;
    models: number;
    modelInventory: TrainingCollectionEvidenceSummary["training"]["modelInventory"];
  };
  benchmarks: {
    actionBenchmarkPairs: number;
    benchmarkComparisons: number;
    caseSamples: number;
    tiers: string[];
    comparisonInventory: TrainingCollectionEvidenceSummary["benchmarks"]["comparisonInventory"];
    baselineProgress: TrainingCollectionEvidenceSummary["benchmarks"]["baselineProgress"];
  };
  evals: {
    evalArtifacts: number;
    evalComparisons: number;
    actionBenchmarks: number;
    benchmarkMatrices: number;
    comparisonInventory: TrainingCollectionEvidenceSummary["evals"]["comparisonInventory"];
  };
  coverage: TrainingCollectionEvidenceSummary["coverage"];
}

export interface ListTrainingCollectionsResult {
  root: string;
  indexJsonPath: string;
  indexHtmlPath: string;
  collections: TrainingCollectionRunSummary[];
}

export interface TrainingCollectionIndex {
  schema: typeof TRAINING_COLLECTION_INDEX_SCHEMA;
  schemaVersion: typeof TRAINING_COLLECTION_INDEX_VERSION;
  generatedAt: string;
  root: string;
  indexJsonPath: string;
  indexHtmlPath: string;
  collections: TrainingCollectionRunSummary[];
}

export interface TrainingCollectionEvidenceSummary {
  preflight: TrainingCollectionPreflightSummary;
  viewerHtmlPath: string;
  analysisManifestPath: string;
  readinessReportPath: string;
  artifactCounts: TrainingAnalysisIndex["manifest"]["counts"];
  coverage: {
    dataSources: TrainingAnalysisIndex["manifest"]["coverage"]["dataSources"];
    readableSamples: TrainingAnalysisIndex["manifest"]["coverage"]["readableSamples"];
    evals: TrainingAnalysisIndex["manifest"]["coverage"]["evals"];
    benchmarks: TrainingAnalysisIndex["manifest"]["coverage"]["benchmarks"];
    models: {
      artifacts: number;
      stagedBundles: number;
      inventoryCount: number;
    };
  };
  stepCounts: Record<TrainingCollectionStep["status"], number>;
  stepArtifacts: TrainingCollectionStepEvidence[];
  dataSources: {
    huggingFaceDatasets: number;
    feedDatasets: number;
    naturalTrajectoryBundles: number;
    scenarioRuns: number;
    scenarioNativeDatasets: number;
    testTrajectories: number;
    trainingJsonlDatasets: number;
  };
  feed: {
    runs: Array<{
      title: string;
      path: string;
      schema: string | null;
      sourceKind: string | null;
      archetype: string | null;
      archetypes: unknown;
      trajectories: number | null;
      totalTicks: number | null;
      durationMs: number | null;
      errors: number | null;
      exportPath: string | null;
      outputDir: string | null;
    }>;
    archetypeStats: Array<{
      title: string;
      path: string;
      archetype: string;
      agents: number | null;
      trajectories: number | null;
      avgTicksPerAgent: number | null;
    }>;
    trajectorySamples: Array<{
      title: string;
      path: string;
      trajectoryId: string | null;
      agentId: string | null;
      archetype: string | null;
      scenarioId: string | null;
      score: number | null;
      finalPnl: number | null;
      steps: number | null;
      firstStep: unknown;
      firstInput: unknown;
      firstOutput: unknown;
      reasoning: unknown;
    }>;
  };
  sourceSamples: {
    huggingFace: TrainingCollectionSourceSample[];
    feed: TrainingCollectionSourceSample[];
    natural: TrainingCollectionSourceSample[];
    scenarios: TrainingCollectionSourceSample[];
    tests: TrainingCollectionSourceSample[];
    trainingJsonl: TrainingCollectionSourceSample[];
  };
  training: {
    trainingRuns: number;
    models: number;
    modelInventory: Array<{
      title: string;
      path: string;
      schema: string | null;
      model: string | null;
      tier: string | null;
      variant: string | null;
      outputPath: string | null;
      baseModel: string | null;
      repoId: string | null;
      baseEvalScore: number | null;
      trainedEvalScore: number | null;
      evalImprovementPercent: number | null;
    }>;
  };
  evals: {
    evalArtifacts: number;
    actionBenchmarks: number;
    evalComparisons: number;
    benchmarkMatrices: number;
    comparisonInventory: Array<{
      title: string;
      path: string;
      baseModel: string | null;
      trainedModel: string | null;
      backend: string | null;
      baseScore: number | null;
      trainedScore: number | null;
      improvementAbsolute: number | null;
      improvementPercent: number | null;
      baseLatencyMs: number | null;
      trainedLatencyMs: number | null;
      latencyDeltaMs: number | null;
      promptCount: number | null;
      distinctResponseCount: number | null;
      reportPath: string | null;
    }>;
  };
  artifactLinks: Array<{
    category:
      | "huggingface"
      | "feed"
      | "natural"
      | "scenario"
      | "test"
      | "training_jsonl"
      | "eval"
      | "benchmark"
      | "model"
      | "other";
    kind: TrainingAnalysisIndex["manifest"]["artifacts"][number]["kind"];
    title: string;
    path: string;
    schema: string | null;
  }>;
  benchmarks: {
    actionBenchmarkPairs: number;
    actionBenchmarkMatrixSources: number;
    benchmarkRows: number;
    benchmarkComparisons: number;
    tiers: string[];
    comparisonInventory: Array<{
      tier: string | null;
      benchmark: string | null;
      baseModelId: string | null;
      trainedModelId: string | null;
      referenceModelId: string | null;
      baseScore: number | null;
      trainedScore: number | null;
      improvementPercent: number | null;
      referenceScore: number | null;
      trainedVsReferencePercent: number | null;
      dryRun: boolean;
      useMocks: boolean;
      modelBacked: boolean;
    }>;
    improvementComparisons: Array<{
      tier: string | null;
      benchmark: string | null;
      baseScore: number | null;
      trainedScore: number | null;
      improvementPercent: number | null;
      referenceScore: number | null;
      trainedVsReferencePercent: number | null;
      modelBacked: boolean;
    }>;
    baselineProgress: {
      tierOrder: string[];
      establishedTiers: string[];
      remainingTiers: string[];
      nextTier: string | null;
      smallestTierEstablished: boolean;
      allTiersEstablished: boolean;
    };
    caseSamples: Array<{
      tier: string | null;
      variant: string | null;
      modelId: string | null;
      benchmark: string | null;
      score: number | null;
      caseId: string | null;
      prompt: string | null;
      expectedAction: string | null;
      actualAction: string | null;
      pass: boolean;
      response: string | null;
      latencyMs: number | null;
      trajectoryPath: string | null;
      useMocks: boolean;
    }>;
  };
  benchmarkReadiness: {
    smallestTier: TrainingReadinessReport["status"];
    allEliza1Tiers: TrainingReadinessReport["status"];
    allEliza1TierImprovements: TrainingReadinessReport["status"];
    cerebrasReference: TrainingReadinessReport["status"];
    baseTrainedImprovement: TrainingReadinessReport["status"];
  };
  readinessGaps: Array<{
    id: string;
    label: string;
    status: TrainingReadinessReport["status"];
    note: string;
    recommendedCapability: string | null;
    recommendedParams: Record<string, unknown> | null;
  }>;
}

export interface TrainingCollectionPreflightSummary {
  liveRequired: boolean;
  checks: Array<{
    id: string;
    label: string;
    status: "ok" | "missing" | "warning" | "skipped";
    detail: string;
    path?: string | null;
  }>;
}

type TrainingCollectionPreflightCheck =
  TrainingCollectionPreflightSummary["checks"][number];

export interface TrainingCollectionStepEvidence {
  stepId: TrainingCollectionStep["id"];
  status: TrainingCollectionStep["status"];
  outputDir: string | null;
  command: string[] | null;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  paths: Array<{
    label: string;
    path: string;
  }>;
}

export interface TrainingCollectionSourceSample {
  title: string;
  path: string;
  schema: string | null;
  sourceKind: string | null;
  trajectoryId: string | null;
  scenarioId: string | null;
  task: string | null;
  input: unknown;
  output: unknown;
  model: string | null;
  systemPrompt?: unknown;
  callId?: string | null;
}

function safeTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function boolWithDefault(
  value: boolean | undefined,
  fallback: boolean,
): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function liveActionBenchmarkRequested(
  options: TrainingCollectionRunOptions,
): boolean {
  return (
    boolWithDefault(options.includeActionBenchmark, true) &&
    options.actionBenchmark?.dryRun === false
  );
}

function liveEvalComparisonRequested(
  options: TrainingCollectionRunOptions,
): boolean {
  return (
    boolWithDefault(options.includeEvalComparison, false) &&
    options.evalComparison?.dryRun === false
  );
}

function liveFeedGenerationRequested(
  options: TrainingCollectionRunOptions,
): boolean {
  return (
    boolWithDefault(options.includeFeed, true) && options.feed?.dryRun === false
  );
}

function liveBenchmarkVsCerebrasRequested(
  options: TrainingCollectionRunOptions,
): boolean {
  return (
    boolWithDefault(options.includeBenchmarkVsCerebras, false) &&
    options.benchmarkVsCerebras?.dryRun === false
  );
}

function fileCheck(
  id: string,
  label: string,
  path: string,
): TrainingCollectionPreflightCheck {
  return existsSync(path)
    ? {
        id,
        label,
        status: "ok",
        detail: "found",
        path,
      }
    : {
        id,
        label,
        status: "missing",
        detail: "required file was not found",
        path,
      };
}

function endpointProbeUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${normalizedPath || ""}/models`;
  return url.toString();
}

async function probeOpenAICompatibleEndpoint(
  baseUrl: string,
): Promise<TrainingCollectionPreflightCheck> {
  const url = endpointProbeUrl(baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    return {
      id: "action_benchmark_endpoint",
      label: "Action benchmark endpoint",
      status: response.ok ? "ok" : "warning",
      detail: response.ok
        ? `OpenAI-compatible endpoint responded at ${url}`
        : `endpoint responded with HTTP ${response.status} at ${url}`,
    };
  } catch (err) {
    return {
      id: "action_benchmark_endpoint",
      label: "Action benchmark endpoint",
      status: "missing",
      detail:
        err instanceof Error && err.name === "AbortError"
          ? `timed out probing OpenAI-compatible endpoint at ${url}`
          : `could not reach OpenAI-compatible endpoint at ${url}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function buildTrainingCollectionPreflight(input: {
  options: TrainingCollectionRunOptions;
  workspaceRoot?: string;
  trainingRoot?: string;
}): TrainingCollectionPreflightSummary {
  const { options, workspaceRoot, trainingRoot } = input;
  const checks: TrainingCollectionPreflightSummary["checks"] = [];
  const actionLive = liveActionBenchmarkRequested(options);
  const evalLive = liveEvalComparisonRequested(options);
  const feedLive = liveFeedGenerationRequested(options);
  const cerebrasLive = liveBenchmarkVsCerebrasRequested(options);
  const liveRequired = actionLive || evalLive || feedLive || cerebrasLive;
  const resolvedWorkspaceRoot =
    workspaceRoot ?? discoverWorkspaceRoot() ?? process.cwd();
  const resolvedTrainingRoot =
    trainingRoot ?? join(resolvedWorkspaceRoot, "packages", "training");

  checks.push(
    fileCheck(
      "app_core_action_benchmark",
      "App-core Eliza harness benchmark",
      join(
        resolvedWorkspaceRoot,
        "packages",
        "app-core",
        "test",
        "benchmarks",
        "action-selection.real.test.ts",
      ),
    ),
  );
  checks.push(
    fileCheck(
      "local_eval_compare_script",
      "Local base-vs-trained eval script",
      join(resolvedTrainingRoot, "scripts", "rl", "compare_local_models.py"),
    ),
  );
  checks.push(
    fileCheck(
      "benchmark_vs_cerebras_script",
      "Benchmark-vs-Cerebras script",
      join(resolvedTrainingRoot, "scripts", "benchmark_vs_cerebras.py"),
    ),
  );

  if (actionLive) {
    const provider = options.actionBenchmark?.provider ?? "local-llama-cpp";
    const baseUrl =
      options.actionBenchmark?.baseUrl ?? "http://localhost:11434/v1";
    checks.push({
      id: "action_benchmark_provider",
      label: "Action benchmark provider",
      status: provider === "local-llama-cpp" ? "warning" : "ok",
      detail:
        provider === "local-llama-cpp"
          ? `local provider selected; verify OpenAI-compatible endpoint is serving at ${baseUrl}`
          : `provider ${provider} selected`,
    });
  } else {
    checks.push({
      id: "action_benchmark_provider",
      label: "Action benchmark provider",
      status: "skipped",
      detail: "live action benchmark not requested",
    });
  }

  if (feedLive) {
    checks.push({
      id: "feed_database_url",
      label: "Feed database URL",
      status: process.env.DATABASE_URL ? "ok" : "missing",
      detail: process.env.DATABASE_URL
        ? "DATABASE_URL is set for live feed generation"
        : "DATABASE_URL is required for live packages/feed train parallel generation",
    });
  } else {
    checks.push({
      id: "feed_database_url",
      label: "Feed database URL",
      status: "skipped",
      detail: "live feed generation not requested",
    });
  }

  if (cerebrasLive) {
    checks.push({
      id: "cerebras_api_key",
      label: "Cerebras API key",
      status: process.env.CEREBRAS_API_KEY ? "ok" : "missing",
      detail: process.env.CEREBRAS_API_KEY
        ? "CEREBRAS_API_KEY is set"
        : "CEREBRAS_API_KEY is required for live Cerebras reference runs",
    });
  } else {
    checks.push({
      id: "cerebras_api_key",
      label: "Cerebras API key",
      status: "skipped",
      detail: "live Cerebras reference run not requested",
    });
  }

  if (evalLive) {
    checks.push({
      id: "eval_model_inputs",
      label: "Eval comparison model inputs",
      status:
        options.evalComparison?.manifestPath ||
        (options.evalComparison?.model &&
          options.evalComparison?.trainedModelPath &&
          options.evalComparison?.backend)
          ? "ok"
          : "missing",
      detail:
        "requires manifestPath or model, trainedModelPath, and backend for live eval comparison",
    });
  } else {
    checks.push({
      id: "eval_model_inputs",
      label: "Eval comparison model inputs",
      status: "skipped",
      detail: "live local eval comparison not requested",
    });
  }

  return { liveRequired, checks };
}

export async function buildTrainingCollectionPreflightWithProbes(input: {
  options: TrainingCollectionRunOptions;
  workspaceRoot?: string;
  trainingRoot?: string;
}): Promise<TrainingCollectionPreflightSummary> {
  const preflight = buildTrainingCollectionPreflight(input);
  if (
    !input.options.preflightProbe ||
    !liveActionBenchmarkRequested(input.options)
  ) {
    return preflight;
  }
  const provider = input.options.actionBenchmark?.provider ?? "local-llama-cpp";
  if (provider !== "local-llama-cpp") {
    return preflight;
  }
  const baseUrl =
    input.options.actionBenchmark?.baseUrl ?? "http://localhost:11434/v1";
  try {
    preflight.checks.push(await probeOpenAICompatibleEndpoint(baseUrl));
  } catch (err) {
    preflight.checks.push({
      id: "action_benchmark_endpoint",
      label: "Action benchmark endpoint",
      status: "warning",
      detail: `endpoint probe failed before request: ${String(err)}`,
    });
  }
  return preflight;
}

function stepOutputDir(outputDir: string, step: string): string {
  return join(outputDir, step);
}

export const ELIZA1_MODEL_REGISTRY_ENTRY_SCHEMA = "eliza1_model_registry_entry";

export interface Eliza1ModelRegistryResult {
  outputDir: string;
  generatedAt: string;
  manifests: Array<{
    tier: string;
    variant: "base" | "trained";
    modelId: string;
    manifestPath: string;
    outputPath: string;
    baseModel: string | null;
  }>;
}

async function writeEliza1ModelRegistryArtifacts(input: {
  outputDir: string;
  generatedAt: string;
}): Promise<Eliza1ModelRegistryResult> {
  await mkdir(input.outputDir, { recursive: true });
  const manifests: Eliza1ModelRegistryResult["manifests"] = [];
  for (const tier of ELIZA_ONE_BENCHMARK_TIERS) {
    for (const variant of ["base", "trained"] as const) {
      const modelId = elizaOneBenchmarkModelId(tier, variant);
      if (!modelId) continue;
      const baseModel =
        variant === "trained"
          ? (elizaOneBenchmarkModelId(tier, "base") ?? null)
          : null;
      const outputPath = `hf://elizaos/${modelId}`;
      const repoId = `elizaos/${modelId}`;
      const manifestPath = join(
        input.outputDir,
        `${tier}-${variant}-model-manifest.json`,
      );
      const manifest = {
        schema: ELIZA1_MODEL_REGISTRY_ENTRY_SCHEMA,
        schemaVersion: 1,
        generatedAt: input.generatedAt,
        source: { kind: "eliza1_model_registry" },
        modelId,
        model_name: modelId,
        output_path: outputPath,
        baseModel,
        tier,
        variant,
        family: "eliza-1",
        repoId,
        registry: {
          provider: "huggingface",
          repoId,
        },
      };
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      manifests.push({
        tier,
        variant,
        modelId,
        manifestPath,
        outputPath,
        baseModel,
      });
    }
  }
  return {
    outputDir: input.outputDir,
    generatedAt: input.generatedAt,
    manifests,
  };
}

function schemaOfArtifact(
  artifact: TrainingAnalysisIndex["manifest"]["artifacts"][number],
): string | undefined {
  const schema = artifact.summary.schema;
  return typeof schema === "string" ? schema : undefined;
}

function sourceKindOfArtifact(
  artifact: TrainingAnalysisIndex["manifest"]["artifacts"][number],
): string | undefined {
  const source = artifact.summary.source;
  if (typeof source === "string") return source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }
  const kind = (source as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : undefined;
}

function artifactEvidenceCategory(
  artifact: TrainingAnalysisIndex["manifest"]["artifacts"][number],
):
  | "huggingface"
  | "feed"
  | "natural"
  | "scenario"
  | "test"
  | "training_jsonl"
  | "eval"
  | "benchmark"
  | "model"
  | "other" {
  const schema = schemaOfArtifact(artifact);
  const sourceKind = sourceKindOfArtifact(artifact);
  if (schema === "eliza_huggingface_dataset_ingest") return "huggingface";
  if (
    schema === "feed_training_trajectory_export" ||
    schema === "feed_parallel_generation"
  ) {
    return "feed";
  }
  if (
    artifact.kind === "trajectory_bundle" &&
    sourceKind === "training_collection_natural_trajectories"
  ) {
    return "natural";
  }
  if (
    artifact.kind === "scenario_run" ||
    schema === "eliza_scenario_native_export"
  ) {
    return "scenario";
  }
  if (sourceKind === "app_core_test_trajectory") return "test";
  if (schema === "eliza_training_jsonl_dataset") return "training_jsonl";
  if (artifact.kind === "benchmark_matrix") return "benchmark";
  if (artifact.kind === "model") return "model";
  if (artifact.kind === "eval") return "eval";
  return "other";
}

function countArtifacts(
  analysis: TrainingAnalysisIndex,
  predicate: (
    artifact: TrainingAnalysisIndex["manifest"]["artifacts"][number],
  ) => boolean,
): number {
  return analysis.manifest.artifacts.filter(predicate).length;
}

function readinessStatus(
  readiness: TrainingReadinessReport,
  id: string,
): TrainingReadinessReport["status"] {
  return readiness.checks.find((check) => check.id === id)?.status ?? "missing";
}

function summarizeStepCounts(
  steps: readonly TrainingCollectionStep[],
): Record<TrainingCollectionStep["status"], number> {
  return {
    skipped: steps.filter((step) => step.status === "skipped").length,
    succeeded: steps.filter((step) => step.status === "succeeded").length,
    failed: steps.filter((step) => step.status === "failed").length,
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanFlagFromRecords(
  key: string,
  ...records: Array<Record<string, unknown> | null | undefined>
): boolean {
  return records.some((record) => record?.[key] === true);
}

function benchmarkRecordIsDryRun(record: Record<string, unknown>): boolean {
  const source = recordValue(record.source);
  const metrics = recordValue(record.metrics);
  const raw = recordValue(record.raw);
  const rawSource = recordValue(raw?.source);
  return booleanFlagFromRecords(
    "dryRun",
    record,
    source,
    metrics,
    raw,
    rawSource,
  );
}

function benchmarkRecordUsesMocks(record: Record<string, unknown>): boolean {
  const source = recordValue(record.source);
  const metrics = recordValue(record.metrics);
  const raw = recordValue(record.raw);
  const rawSource = recordValue(raw?.source);
  return booleanFlagFromRecords(
    "useMocks",
    record,
    source,
    metrics,
    raw,
    rawSource,
  );
}

function normalizeBenchmarkTier(value: unknown): string | null {
  const tier = stringOrNull(value);
  if (!tier) return null;
  return tier;
}

function benchmarkComparisonHasModelBackedRows(
  comparison: Record<string, unknown>,
  rows: readonly unknown[],
): boolean {
  const tier = normalizeBenchmarkTier(comparison.tier);
  const benchmark = stringOrNull(comparison.benchmark);
  if (!tier || !benchmark) return false;
  const hasVariant = (variant: "base" | "trained") =>
    rows
      .map(recordValue)
      .filter((row): row is Record<string, unknown> => Boolean(row))
      .some(
        (row) =>
          row.variant === variant &&
          normalizeBenchmarkTier(row.tier) === tier &&
          stringOrNull(row.benchmark) === benchmark &&
          numberOrNull(row.score) !== null &&
          !benchmarkRecordIsDryRun(row) &&
          !benchmarkRecordUsesMocks(row),
      );
  return hasVariant("base") && hasVariant("trained");
}

function benchmarkComparisonUsesMocks(
  comparison: Record<string, unknown>,
  rows: readonly unknown[],
): boolean {
  const tier = normalizeBenchmarkTier(comparison.tier);
  const benchmark = stringOrNull(comparison.benchmark);
  if (!tier || !benchmark) return false;
  return rows
    .map(recordValue)
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .some(
      (row) =>
        (row.variant === "base" || row.variant === "trained") &&
        normalizeBenchmarkTier(row.tier) === tier &&
        stringOrNull(row.benchmark) === benchmark &&
        benchmarkRecordUsesMocks(row),
    );
}

function sanitizeRecipeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeRecipeValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/token|secret|password|api[_-]?key/i.test(key)) continue;
    if (key === "trajectories") {
      out.trajectoryCount = Array.isArray(item) ? item.length : 0;
      continue;
    }
    out[key] = sanitizeRecipeValue(item);
  }
  return out;
}

function sanitizeRecipeRecord(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeRecipeValue(value);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : {};
}

function isPathLikeKey(key: string): boolean {
  return (
    /(?:path|dir)$/i.test(key) ||
    key === "outputDir" ||
    key === "matrixOutputDir" ||
    key === "trajectoryDir"
  );
}

function collectCommand(value: unknown): string[] | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const command = collectCommand(item);
      if (command) return command;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    Array.isArray(record.command) &&
    record.command.every((part) => typeof part === "string")
  ) {
    return record.command as string[];
  }
  for (const item of Object.values(record)) {
    const command = collectCommand(item);
    if (command) return command;
  }
  return null;
}

function collectStepPaths(
  value: unknown,
  prefix = "",
  depth = 0,
): Array<{ label: string; path: string }> {
  if (!value || typeof value !== "object" || depth > 4) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectStepPaths(item, `${prefix}[${index}]`, depth + 1),
    );
  }
  const out: Array<{ label: string; path: string }> = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (typeof item === "string" && item.trim() && isPathLikeKey(key)) {
      out.push({ label, path: item.trim() });
      continue;
    }
    out.push(...collectStepPaths(item, label, depth + 1));
  }
  return out;
}

function outputExcerpt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}...` : trimmed;
}

function collectOutputText(
  value: unknown,
  key: "stdout" | "stderr",
  depth = 0,
): string | null {
  if (!value || typeof value !== "object" || depth > 5) return null;
  const excerpts: string[] = [];
  const visit = (item: unknown, itemDepth: number) => {
    if (!item || typeof item !== "object" || itemDepth > 5) return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child, itemDepth + 1);
      return;
    }
    const record = item as Record<string, unknown>;
    const excerpt = outputExcerpt(record[key]);
    if (excerpt && !excerpts.includes(excerpt)) excerpts.push(excerpt);
    if (excerpts.length >= 4) return;
    for (const child of Object.values(record)) {
      visit(child, itemDepth + 1);
      if (excerpts.length >= 4) return;
    }
  };
  visit(value, depth);
  return excerpts.length > 0 ? excerpts.join("\n---\n") : null;
}

function summarizeStepArtifacts(
  steps: readonly TrainingCollectionStep[],
): TrainingCollectionStepEvidence[] {
  return steps.map((step) => {
    const result = resultRecord(step);
    const uniquePaths = Array.from(
      new Map(
        collectStepPaths(result).map((entry) => [
          `${entry.label}:${entry.path}`,
          entry,
        ]),
      ).values(),
    ).slice(0, 32);
    return {
      stepId: step.id,
      status: step.status,
      outputDir: step.outputDir,
      command: collectCommand(result),
      exitCode: numberOrNull(result.exitCode),
      stdout:
        outputExcerpt(result.stdout) ?? collectOutputText(result, "stdout"),
      stderr:
        outputExcerpt(result.stderr) ?? collectOutputText(result, "stderr"),
      paths: uniquePaths,
    };
  });
}

function buildCollectionRecipe(
  options: TrainingCollectionRunOptions,
): TrainingCollectionRecipe {
  const defaultPair = shouldUseDefaultActionBenchmarkPair(options)
    ? defaultActionBenchmarkPair(options)
    : undefined;
  const actionBenchmarkPair = options.actionBenchmarkPair ?? defaultPair;
  return {
    include: {
      huggingFace: boolWithDefault(options.includeHuggingFace, true),
      feed: boolWithDefault(options.includeFeed, true),
      naturalTrajectories: boolWithDefault(
        options.includeNaturalTrajectories,
        false,
      ),
      testTrajectories: boolWithDefault(options.includeTestTrajectories, false),
      scenarios: boolWithDefault(options.includeScenarios, true),
      evalComparison: boolWithDefault(options.includeEvalComparison, false),
      actionBenchmark: boolWithDefault(options.includeActionBenchmark, true),
      benchmarkVsCerebras: boolWithDefault(
        options.includeBenchmarkVsCerebras,
        false,
      ),
      eliza1ModelRegistry: boolWithDefault(
        options.includeEliza1ModelRegistry,
        true,
      ),
      eliza1BundleStage: boolWithDefault(
        options.includeEliza1BundleStage,
        false,
      ),
      benchmarkMatrix: boolWithDefault(options.includeBenchmarkMatrix, true),
    },
    sources: {
      huggingFace: sanitizeRecipeRecord(options.huggingFace),
      feed: sanitizeRecipeRecord(options.feed),
      naturalTrajectories: sanitizeRecipeRecord(options.naturalTrajectories),
      testTrajectories: sanitizeRecipeRecord(options.testTrajectories),
      scenarios: sanitizeRecipeRecord(options.scenarios),
    },
    evals: {
      evalComparison: sanitizeRecipeRecord(options.evalComparison),
      actionBenchmark: sanitizeRecipeRecord(options.actionBenchmark),
      actionBenchmarkPair: actionBenchmarkPair
        ? sanitizeRecipeRecord(actionBenchmarkPair)
        : null,
      actionBenchmarkPairs: actionBenchmarkPairsOption(
        options.actionBenchmarkPairs,
      ).map(sanitizeRecipeRecord),
      benchmarkVsCerebras: sanitizeRecipeRecord(options.benchmarkVsCerebras),
      benchmarkMatrix: sanitizeRecipeRecord(options.benchmarkMatrix),
    },
    training: {
      eliza1ModelRegistry: {},
      eliza1BundleStage: sanitizeRecipeRecord(options.eliza1BundleStage),
    },
  };
}

function summarizeBenchmarkEvidence(input: {
  analysis: TrainingAnalysisIndex;
  steps: readonly TrainingCollectionStep[];
}): TrainingCollectionEvidenceSummary["benchmarks"] {
  const actionBenchmarkResult = recordValue(
    input.steps.find((step) => step.id === "action_benchmark")?.result,
  );
  const actionBenchmarkPairs = Array.isArray(actionBenchmarkResult?.pairs)
    ? actionBenchmarkResult.pairs.length
    : 0;
  const actionBenchmarkMatrixSources = Array.isArray(
    actionBenchmarkResult?.matrixSources,
  )
    ? actionBenchmarkResult.matrixSources.length
    : 0;
  const matrixArtifacts = input.analysis.manifest.artifacts.filter(
    (artifact) => artifact.kind === "benchmark_matrix",
  );
  const rows = matrixArtifacts.flatMap((artifact) =>
    Array.isArray(recordValue(artifact.payload)?.rows)
      ? (recordValue(artifact.payload)?.rows as unknown[])
      : [],
  );
  const comparisons = matrixArtifacts.flatMap((artifact) =>
    Array.isArray(recordValue(artifact.payload)?.comparisons)
      ? (recordValue(artifact.payload)?.comparisons as unknown[])
      : [],
  );
  const tiers = Array.from(
    new Set(
      comparisons
        .map((comparison) => stringOrNull(recordValue(comparison)?.tier))
        .filter((tier): tier is string => tier !== null),
    ),
  ).sort(canonicalElizaOneTierSort);
  const comparisonInventory = comparisons
    .map(recordValue)
    .filter((comparison): comparison is Record<string, unknown> =>
      Boolean(comparison),
    )
    .map((comparison) => {
      const modelBacked = benchmarkComparisonHasModelBackedRows(
        comparison,
        rows,
      );
      return {
        tier: stringOrNull(comparison.tier),
        benchmark: stringOrNull(comparison.benchmark),
        baseModelId: stringOrNull(comparison.baseModelId),
        trainedModelId: stringOrNull(comparison.trainedModelId),
        referenceModelId: stringOrNull(comparison.referenceModelId),
        baseScore: numberOrNull(comparison.baseScore),
        trainedScore: numberOrNull(comparison.trainedScore),
        improvementPercent: numberOrNull(comparison.improvementPercent),
        referenceScore: numberOrNull(comparison.referenceScore),
        trainedVsReferencePercent: numberOrNull(
          comparison.trainedVsReferencePercent,
        ),
        dryRun: comparison.dryRun === true,
        useMocks: benchmarkComparisonUsesMocks(comparison, rows),
        modelBacked,
      };
    });
  const improvementComparisons = comparisonInventory
    .filter(
      (comparison) =>
        comparison.dryRun !== true &&
        comparison.modelBacked &&
        (comparison.baseScore !== null ||
          comparison.trainedScore !== null ||
          comparison.improvementPercent !== null),
    )
    .map((comparison) => ({
      tier: comparison.tier,
      benchmark: comparison.benchmark,
      baseScore: comparison.baseScore,
      trainedScore: comparison.trainedScore,
      improvementPercent: comparison.improvementPercent,
      referenceScore: comparison.referenceScore,
      trainedVsReferencePercent: comparison.trainedVsReferencePercent,
      modelBacked: true,
    }));
  const establishedTiers = Array.from(
    new Set(
      improvementComparisons
        .map((comparison) => normalizeBenchmarkTier(comparison.tier))
        .filter(
          (tier): tier is string =>
            tier !== null &&
            (ELIZA_ONE_BENCHMARK_TIERS as readonly string[]).includes(tier),
        ),
    ),
  ).sort(canonicalElizaOneTierSort);
  const remainingTiers = ELIZA_ONE_BENCHMARK_TIERS.filter(
    (tier) => !establishedTiers.includes(tier),
  );
  return {
    actionBenchmarkPairs,
    actionBenchmarkMatrixSources,
    benchmarkRows: rows.length,
    benchmarkComparisons: comparisons.length,
    tiers,
    comparisonInventory,
    improvementComparisons,
    baselineProgress: {
      tierOrder: [...ELIZA_ONE_BENCHMARK_TIERS],
      establishedTiers,
      remainingTiers,
      nextTier: remainingTiers[0] ?? null,
      smallestTierEstablished: establishedTiers.includes("2b"),
      allTiersEstablished: remainingTiers.length === 0,
    },
    caseSamples: rows
      .map(recordValue)
      .filter((row): row is Record<string, unknown> => Boolean(row))
      .flatMap((row) => {
        const raw = recordValue(row.raw);
        const caseSamples = Array.isArray(raw?.caseSamples)
          ? raw.caseSamples
          : [];
        return caseSamples
          .map(recordValue)
          .filter((sample): sample is Record<string, unknown> =>
            Boolean(sample),
          )
          .map((sample) => ({
            tier: stringOrNull(row.tier),
            variant: stringOrNull(row.variant),
            modelId: stringOrNull(row.modelId),
            benchmark: stringOrNull(row.benchmark),
            score: numberOrNull(row.score),
            caseId: stringOrNull(sample.caseId),
            prompt: stringOrNull(sample.prompt),
            expectedAction: stringOrNull(sample.expectedAction),
            actualAction: stringOrNull(sample.actualAction),
            pass: sample.pass === true,
            response: stringOrNull(sample.response),
            latencyMs: numberOrNull(sample.latencyMs),
            trajectoryPath: stringOrNull(sample.trajectoryPath),
            useMocks: benchmarkRecordUsesMocks(row),
          }));
      })
      .slice(0, 24),
  };
}

function summarizeModelInventory(
  analysis: TrainingAnalysisIndex,
): TrainingCollectionEvidenceSummary["training"]["modelInventory"] {
  return analysis.manifest.artifacts
    .filter((artifact) => artifact.kind === "model")
    .filter((artifact) => {
      const summary = artifact.summary;
      return (
        stringOrNull(summary.model) !== null ||
        stringOrNull(summary.outputPath) !== null
      );
    })
    .map((artifact) => {
      const summary = artifact.summary;
      return {
        title: artifact.title,
        path: artifact.path,
        schema: schemaOfArtifact(artifact) ?? null,
        model: stringOrNull(summary.model),
        tier: stringOrNull(summary.tier),
        variant: stringOrNull(summary.variant),
        outputPath: stringOrNull(summary.outputPath),
        baseModel: stringOrNull(summary.baseModel),
        repoId: stringOrNull(summary.repoId),
        baseEvalScore: numberOrNull(summary.baseEvalScore),
        trainedEvalScore: numberOrNull(summary.trainedEvalScore),
        evalImprovementPercent: numberOrNull(summary.evalImprovementPercent),
      };
    })
    .sort((left, right) => {
      const byTier = canonicalElizaOneTierSort(
        left.tier ?? "",
        right.tier ?? "",
      );
      if (byTier !== 0) return byTier;
      const byVariant =
        (left.variant === "trained" ? 1 : 0) -
        (right.variant === "trained" ? 1 : 0);
      if (byVariant !== 0) return byVariant;
      return left.title.localeCompare(right.title);
    });
}

function summarizeEvalComparisonInventory(
  analysis: TrainingAnalysisIndex,
): TrainingCollectionEvidenceSummary["evals"]["comparisonInventory"] {
  return analysis.manifest.artifacts
    .filter(
      (artifact) =>
        artifact.kind === "eval" &&
        schemaOfArtifact(artifact) === EVAL_COMPARISON_ARTIFACT_SCHEMA,
    )
    .map((artifact) => {
      const summary = artifact.summary;
      return {
        title: artifact.title,
        path: artifact.path,
        baseModel: stringOrNull(summary.baseModel),
        trainedModel: stringOrNull(summary.trainedModel),
        backend: stringOrNull(summary.backend),
        baseScore: numberOrNull(summary.baseScore),
        trainedScore: numberOrNull(summary.trainedScore),
        improvementAbsolute: numberOrNull(summary.improvementAbsolute),
        improvementPercent: numberOrNull(summary.improvementPercent),
        baseLatencyMs: numberOrNull(summary.baseLatencyMs),
        trainedLatencyMs: numberOrNull(summary.trainedLatencyMs),
        latencyDeltaMs: numberOrNull(summary.latencyDeltaMs),
        promptCount: numberOrNull(summary.promptCount),
        distinctResponseCount: numberOrNull(summary.distinctResponseCount),
        reportPath: stringOrNull(summary.reportPath),
      };
    })
    .sort((left, right) => left.title.localeCompare(right.title));
}

function summarizeFeedEvidence(
  analysis: TrainingAnalysisIndex,
): TrainingCollectionEvidenceSummary["feed"] {
  const feedArtifacts = analysis.manifest.artifacts.filter(
    (artifact) =>
      artifact.kind === "trajectory_dataset" &&
      (schemaOfArtifact(artifact) === "feed_training_trajectory_export" ||
        schemaOfArtifact(artifact) === "feed_parallel_generation"),
  );
  const runs: TrainingCollectionEvidenceSummary["feed"]["runs"] = [];
  const archetypeStats: TrainingCollectionEvidenceSummary["feed"]["archetypeStats"] =
    [];
  const trajectorySamples: TrainingCollectionEvidenceSummary["feed"]["trajectorySamples"] =
    [];

  for (const artifact of feedArtifacts) {
    const summary = artifact.summary;
    const source = recordValue(summary.source) ?? {};
    runs.push({
      title: artifact.title,
      path: artifact.path,
      schema: schemaOfArtifact(artifact) ?? null,
      sourceKind: stringOrNull(source.kind),
      archetype: stringOrNull(source.archetype),
      archetypes: source.archetypes ?? null,
      trajectories: numberOrNull(summary.trajectories),
      totalTicks: numberOrNull(summary.totalTicks),
      durationMs: numberOrNull(summary.durationMs),
      errors: numberOrNull(summary.errors),
      exportPath: stringOrNull(summary.exportPath),
      outputDir: stringOrNull(summary.outputDir),
    });

    const stats = recordValue(summary.archetypeStats);
    if (stats) {
      for (const [archetype, value] of Object.entries(stats)) {
        const row = recordValue(value) ?? {};
        archetypeStats.push({
          title: artifact.title,
          path: artifact.path,
          archetype,
          agents: numberOrNull(row.agents),
          trajectories: numberOrNull(row.trajectories),
          avgTicksPerAgent: numberOrNull(row.avgTicksPerAgent),
        });
      }
    }

    const samples = Array.isArray(summary.feedSamplePreviews)
      ? summary.feedSamplePreviews
      : [];
    for (const sample of samples) {
      const row = recordValue(sample);
      if (!row) continue;
      trajectorySamples.push({
        title: artifact.title,
        path: artifact.path,
        trajectoryId: stringOrNull(row.trajectoryId),
        agentId: stringOrNull(row.agentId),
        archetype: stringOrNull(row.archetype),
        scenarioId: stringOrNull(row.scenarioId),
        score: numberOrNull(row.score),
        finalPnl: numberOrNull(row.finalPnl),
        steps: numberOrNull(row.steps),
        firstStep: row.firstStep ?? null,
        firstInput: row.firstInput ?? null,
        firstOutput: row.firstOutput ?? null,
        reasoning: row.reasoning ?? null,
      });
    }
  }

  return { runs, archetypeStats, trajectorySamples };
}

function collectionSourceSample(
  artifact: TrainingAnalysisIndex["manifest"]["artifacts"][number],
  row: Record<string, unknown>,
): TrainingCollectionSourceSample {
  const source = recordValue(artifact.summary.source) ?? {};
  return {
    title: artifact.title,
    path: artifact.path,
    schema: schemaOfArtifact(artifact) ?? null,
    sourceKind:
      stringOrNull(source.kind) ?? stringOrNull(artifact.summary.source),
    trajectoryId: stringOrNull(row.trajectoryId),
    scenarioId: stringOrNull(row.scenarioId),
    task:
      stringOrNull(row.task) ??
      stringOrNull(row.taskType) ??
      stringOrNull(row.purpose),
    input: row.input ?? row.llmInput ?? row.firstInput ?? row.firstStep ?? null,
    output:
      row.output ?? row.llmOutput ?? row.firstOutput ?? row.reasoning ?? null,
    model: stringOrNull(row.model) ?? stringOrNull(row.provider),
    systemPrompt: row.systemPrompt ?? null,
    callId: stringOrNull(row.callId),
  };
}

function appendSamplesFromSummary(
  target: TrainingCollectionSourceSample[],
  artifact: TrainingAnalysisIndex["manifest"]["artifacts"][number],
  key: string,
): void {
  const samples = Array.isArray(artifact.summary[key])
    ? artifact.summary[key]
    : [];
  for (const sample of samples) {
    const row = recordValue(sample);
    if (!row) continue;
    target.push(collectionSourceSample(artifact, row));
  }
}

function summarizeSourceSamples(
  analysis: TrainingAnalysisIndex,
): TrainingCollectionEvidenceSummary["sourceSamples"] {
  const samples: TrainingCollectionEvidenceSummary["sourceSamples"] = {
    huggingFace: [],
    feed: [],
    natural: [],
    scenarios: [],
    tests: [],
    trainingJsonl: [],
  };

  for (const artifact of analysis.manifest.artifacts) {
    const schema = schemaOfArtifact(artifact);
    if (schema === "eliza_huggingface_dataset_ingest") {
      appendSamplesFromSummary(
        samples.huggingFace,
        artifact,
        "hfSamplePreviews",
      );
    } else if (
      artifact.kind === "trajectory_dataset" &&
      (schema === "feed_training_trajectory_export" ||
        schema === "feed_parallel_generation")
    ) {
      appendSamplesFromSummary(samples.feed, artifact, "feedSamplePreviews");
    } else if (
      artifact.kind === "trajectory_bundle" &&
      sourceKindOfArtifact(artifact) ===
        "training_collection_natural_trajectories"
    ) {
      const callPreviews = Array.isArray(artifact.summary.llmCallPreviews)
        ? artifact.summary.llmCallPreviews
        : [];
      appendSamplesFromSummary(
        samples.natural,
        artifact,
        callPreviews.length > 0 ? "llmCallPreviews" : "samplePreviews",
      );
    } else if (artifact.kind === "scenario_run") {
      appendSamplesFromSummary(samples.scenarios, artifact, "turnPreviews");
    } else if (schema === "eliza_scenario_native_export") {
      appendSamplesFromSummary(
        samples.scenarios,
        artifact,
        "scenarioNativeSamplePreviews",
      );
    } else if (
      schema === "eliza_test_trajectory_record" &&
      sourceKindOfArtifact(artifact) === "app_core_test_trajectory"
    ) {
      appendSamplesFromSummary(samples.tests, artifact, "testSamplePreviews");
    } else if (schema === "eliza_training_jsonl_dataset") {
      appendSamplesFromSummary(
        samples.trainingJsonl,
        artifact,
        "samplePreviews",
      );
    }
  }

  return {
    huggingFace: samples.huggingFace.slice(0, 12),
    feed: samples.feed.slice(0, 12),
    natural: samples.natural.slice(0, 12),
    scenarios: samples.scenarios.slice(0, 12),
    tests: samples.tests.slice(0, 12),
    trainingJsonl: samples.trainingJsonl.slice(0, 12),
  };
}

function buildCollectionEvidenceSummary(input: {
  analysis: TrainingAnalysisIndex;
  readiness: TrainingReadinessReport;
  steps: readonly TrainingCollectionStep[];
  preflight: TrainingCollectionPreflightSummary;
}): TrainingCollectionEvidenceSummary {
  const { analysis, readiness, steps, preflight } = input;
  return {
    preflight,
    viewerHtmlPath: analysis.indexHtmlPath,
    analysisManifestPath: analysis.manifestPath,
    readinessReportPath: readiness.reportPath,
    artifactCounts: analysis.manifest.counts,
    coverage: {
      dataSources: analysis.manifest.coverage.dataSources,
      readableSamples: analysis.manifest.coverage.readableSamples,
      evals: analysis.manifest.coverage.evals,
      benchmarks: analysis.manifest.coverage.benchmarks,
      models: {
        artifacts: analysis.manifest.coverage.models.artifacts,
        stagedBundles: analysis.manifest.coverage.models.stagedBundles,
        inventoryCount: analysis.manifest.coverage.models.inventory.length,
      },
    },
    stepCounts: summarizeStepCounts(steps),
    stepArtifacts: summarizeStepArtifacts(steps),
    dataSources: {
      huggingFaceDatasets: countArtifacts(
        analysis,
        (artifact) =>
          artifact.kind === "trajectory_dataset" &&
          schemaOfArtifact(artifact) === "eliza_huggingface_dataset_ingest",
      ),
      feedDatasets: countArtifacts(
        analysis,
        (artifact) =>
          artifact.kind === "trajectory_dataset" &&
          (schemaOfArtifact(artifact) === "feed_training_trajectory_export" ||
            schemaOfArtifact(artifact) === "feed_parallel_generation"),
      ),
      naturalTrajectoryBundles: countArtifacts(
        analysis,
        (artifact) =>
          artifact.kind === "trajectory_bundle" &&
          sourceKindOfArtifact(artifact) ===
            "training_collection_natural_trajectories",
      ),
      scenarioRuns: countArtifacts(
        analysis,
        (artifact) => artifact.kind === "scenario_run",
      ),
      scenarioNativeDatasets: countArtifacts(
        analysis,
        (artifact) =>
          artifact.kind === "trajectory_dataset" &&
          schemaOfArtifact(artifact) === "eliza_scenario_native_export",
      ),
      testTrajectories: countArtifacts(
        analysis,
        (artifact) =>
          artifact.kind === "trajectory_dataset" &&
          sourceKindOfArtifact(artifact) === "app_core_test_trajectory",
      ),
      trainingJsonlDatasets: countArtifacts(
        analysis,
        (artifact) =>
          artifact.kind === "trajectory_dataset" &&
          schemaOfArtifact(artifact) === "eliza_training_jsonl_dataset",
      ),
    },
    feed: summarizeFeedEvidence(analysis),
    sourceSamples: summarizeSourceSamples(analysis),
    training: {
      trainingRuns: analysis.manifest.counts.trainingRuns,
      models: analysis.manifest.counts.models,
      modelInventory: summarizeModelInventory(analysis),
    },
    evals: {
      evalArtifacts: analysis.manifest.counts.evals,
      actionBenchmarks: countArtifacts(
        analysis,
        (artifact) =>
          artifact.kind === "eval" &&
          schemaOfArtifact(artifact) ===
            "eliza_action_selection_benchmark_report",
      ),
      evalComparisons: countArtifacts(
        analysis,
        (artifact) =>
          artifact.kind === "eval" &&
          schemaOfArtifact(artifact) === EVAL_COMPARISON_ARTIFACT_SCHEMA,
      ),
      benchmarkMatrices: analysis.manifest.counts.benchmarkMatrices,
      comparisonInventory: summarizeEvalComparisonInventory(analysis),
    },
    artifactLinks: analysis.manifest.artifacts.map((artifact) => ({
      category: artifactEvidenceCategory(artifact),
      kind: artifact.kind,
      title: artifact.title,
      path: artifact.path,
      schema: schemaOfArtifact(artifact) ?? null,
    })),
    benchmarks: summarizeBenchmarkEvidence({ analysis, steps }),
    benchmarkReadiness: {
      smallestTier: readinessStatus(readiness, "smallest_model_benchmark"),
      allEliza1Tiers: readinessStatus(readiness, "all_eliza1_tiers_benchmark"),
      allEliza1TierImprovements: readinessStatus(
        readiness,
        "all_eliza1_tier_improvements",
      ),
      cerebrasReference: readinessStatus(readiness, "cerebras_reference"),
      baseTrainedImprovement: readinessStatus(
        readiness,
        "base_trained_improvement",
      ),
    },
    readinessGaps: readiness.checks
      .filter((check) => check.status !== "ready")
      .map((check) => ({
        id: check.id,
        label: check.label,
        status: check.status,
        note: check.note,
        recommendedCapability: check.recommendedAction?.capability ?? null,
        recommendedParams: check.recommendedAction?.params ?? null,
      })),
  };
}

function markdownInline(value: unknown): string {
  if (value === null || value === undefined || value === "") return "n/a";
  if (typeof value === "string") {
    return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function markdownPathLink(value: unknown): string {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path) return "n/a";
  const label = basename(path) || path;
  const href = /^[a-z][a-z0-9+.-]*:\/\//i.test(path) ? path : fileHref(path);
  return `[${label.replace(/\]/g, "\\]")}](${href.replace(/\)/g, "%29")})`;
}

function markdownTable(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  if (rows.length === 0) return "_None._\n";
  return [
    `| ${headers.map(markdownInline).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownInline).join(" | ")} |`),
    "",
  ].join("\n");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fileHref(path: string): string {
  // `file://${path}` yields a broken URL for Windows drive paths (C:\… →
  // file://C:%5C…). toLocalFileUrl produces file:///C:/… on both platforms.
  return toLocalFileUrl(path);
}

function compactCollectionIndexValue(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : value === null || value === undefined
        ? ""
        : JSON.stringify(value);
  return raw.length > 180 ? `${raw.slice(0, 177)}...` : raw;
}

function isTrainingCollectionManifest(
  value: unknown,
): value is TrainingCollectionRunManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schema === TRAINING_COLLECTION_RUN_SCHEMA &&
    record.schemaVersion === TRAINING_COLLECTION_RUN_VERSION &&
    typeof record.generatedAt === "string" &&
    typeof record.outputDir === "string" &&
    typeof record.manifestPath === "string" &&
    typeof record.readmePath === "string" &&
    record.analysis !== null &&
    typeof record.analysis === "object" &&
    !Array.isArray(record.analysis) &&
    typeof (record.analysis as Record<string, unknown>).indexHtmlPath ===
      "string" &&
    record.readiness !== null &&
    typeof record.readiness === "object" &&
    !Array.isArray(record.readiness) &&
    record.evidence !== null &&
    typeof record.evidence === "object" &&
    !Array.isArray(record.evidence)
  );
}

function emptyCollectionCoverage(): TrainingCollectionEvidenceSummary["coverage"] {
  return {
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
      stagedBundles: 0,
      inventoryCount: 0,
    },
  };
}

function collectionCoverage(
  evidence: TrainingCollectionRunManifest["evidence"],
): TrainingCollectionEvidenceSummary["coverage"] {
  return evidence.coverage ?? emptyCollectionCoverage();
}

function collectionBaselineProgress(
  benchmarks: Partial<TrainingCollectionEvidenceSummary["benchmarks"]>,
): TrainingCollectionEvidenceSummary["benchmarks"]["baselineProgress"] {
  const existing =
    benchmarks.baselineProgress &&
    typeof benchmarks.baselineProgress === "object"
      ? benchmarks.baselineProgress
      : null;
  if (
    existing &&
    Array.isArray(existing.tierOrder) &&
    Array.isArray(existing.establishedTiers) &&
    Array.isArray(existing.remainingTiers)
  ) {
    return {
      tierOrder: existing.tierOrder,
      establishedTiers: existing.establishedTiers,
      remainingTiers: existing.remainingTiers,
      nextTier: existing.nextTier ?? null,
      smallestTierEstablished: existing.smallestTierEstablished === true,
      allTiersEstablished: existing.allTiersEstablished === true,
    };
  }
  const establishedTiers = Array.from(
    new Set(
      (benchmarks.improvementComparisons ?? [])
        .map((comparison) => normalizeBenchmarkTier(comparison.tier))
        .filter(
          (tier): tier is string =>
            tier !== null &&
            (ELIZA_ONE_BENCHMARK_TIERS as readonly string[]).includes(tier),
        ),
    ),
  ).sort(canonicalElizaOneTierSort);
  const remainingTiers = ELIZA_ONE_BENCHMARK_TIERS.filter(
    (tier) => !establishedTiers.includes(tier),
  );
  return {
    tierOrder: [...ELIZA_ONE_BENCHMARK_TIERS],
    establishedTiers,
    remainingTiers,
    nextTier: remainingTiers[0] ?? null,
    smallestTierEstablished: establishedTiers.includes("2b"),
    allTiersEstablished: remainingTiers.length === 0,
  };
}

function summarizeCollectionManifest(
  manifest: TrainingCollectionRunManifest,
): TrainingCollectionRunSummary {
  const coverage = collectionCoverage(manifest.evidence);
  const trainingEvidence = manifest.evidence.training ?? {
    trainingRuns: 0,
    models: 0,
    modelInventory: [],
  };
  const baselineProgress = collectionBaselineProgress(
    manifest.evidence.benchmarks,
  );
  const benchmarkComparisonInventory =
    manifest.evidence.benchmarks.comparisonInventory?.length > 0
      ? manifest.evidence.benchmarks.comparisonInventory
      : (manifest.evidence.benchmarks.improvementComparisons ?? []).map(
          (comparison) => ({
            tier: comparison.tier,
            benchmark: comparison.benchmark,
            baseModelId: null,
            trainedModelId: null,
            referenceModelId: null,
            baseScore: comparison.baseScore,
            trainedScore: comparison.trainedScore,
            improvementPercent: comparison.improvementPercent,
            referenceScore: comparison.referenceScore,
            trainedVsReferencePercent: comparison.trainedVsReferencePercent,
            dryRun: false,
            useMocks: false,
            modelBacked: comparison.modelBacked,
          }),
        );
  const sourceArtifacts = (manifest.evidence.artifactLinks ?? [])
    .filter(
      (
        artifact,
      ): artifact is typeof artifact & {
        category:
          | "huggingface"
          | "feed"
          | "natural"
          | "scenario"
          | "test"
          | "training_jsonl";
      } =>
        artifact.category === "huggingface" ||
        artifact.category === "feed" ||
        artifact.category === "natural" ||
        artifact.category === "scenario" ||
        artifact.category === "test" ||
        artifact.category === "training_jsonl",
    )
    .slice(0, 12)
    .map((artifact) => ({
      category: artifact.category,
      title: artifact.title,
      path: artifact.path,
      schema: artifact.schema,
    }));
  const evidenceSourceSamples = manifest.evidence.sourceSamples ?? {
    huggingFace: [],
    feed: [],
    natural: [],
    scenarios: [],
    tests: [],
    trainingJsonl: [],
  };
  const sourceSamples = {
    huggingFace: (evidenceSourceSamples.huggingFace ?? []).slice(0, 3),
    feed: (evidenceSourceSamples.feed ?? []).slice(0, 3),
    natural: (evidenceSourceSamples.natural ?? []).slice(0, 3),
    scenarios: (evidenceSourceSamples.scenarios ?? []).slice(0, 3),
    tests: (evidenceSourceSamples.tests ?? []).slice(0, 3),
    trainingJsonl: (evidenceSourceSamples.trainingJsonl ?? []).slice(0, 3),
  };
  const evidenceArtifacts = (manifest.evidence.artifactLinks ?? [])
    .filter(
      (
        artifact,
      ): artifact is typeof artifact & {
        category: "eval" | "benchmark" | "model";
      } =>
        artifact.category === "eval" ||
        artifact.category === "benchmark" ||
        artifact.category === "model",
    )
    .slice(0, 12)
    .map((artifact) => ({
      category: artifact.category,
      title: artifact.title,
      path: artifact.path,
      schema: artifact.schema,
    }));
  return {
    generatedAt: manifest.generatedAt,
    outputDir: manifest.outputDir,
    manifestPath: manifest.manifestPath,
    readmePath: manifest.readmePath,
    analysisIndexHtmlPath: manifest.analysis.indexHtmlPath,
    readinessStatus: manifest.readiness.status,
    readiness: {
      ready: manifest.readiness.ready,
      partial: manifest.readiness.partial,
      missing: manifest.readiness.missing,
    },
    readinessGaps: (manifest.evidence.readinessGaps ?? []).slice(0, 8),
    artifactCount: manifest.analysis.artifactCount,
    stepCounts: manifest.evidence.stepCounts,
    dataSources: manifest.evidence.dataSources,
    sourceSamples,
    sourceArtifacts,
    evidenceArtifacts,
    training: {
      trainingRuns: trainingEvidence.trainingRuns,
      models: trainingEvidence.models,
      modelInventory: (trainingEvidence.modelInventory ?? []).slice(0, 5),
    },
    benchmarks: {
      actionBenchmarkPairs: manifest.evidence.benchmarks.actionBenchmarkPairs,
      benchmarkComparisons: manifest.evidence.benchmarks.benchmarkComparisons,
      caseSamples: manifest.evidence.benchmarks.caseSamples?.length ?? 0,
      tiers: manifest.evidence.benchmarks.tiers,
      comparisonInventory: benchmarkComparisonInventory.slice(0, 5),
      baselineProgress,
    },
    evals: {
      evalArtifacts: manifest.evidence.evals.evalArtifacts,
      evalComparisons: manifest.evidence.evals.evalComparisons,
      actionBenchmarks: manifest.evidence.evals.actionBenchmarks,
      benchmarkMatrices: manifest.evidence.evals.benchmarkMatrices,
      comparisonInventory:
        manifest.evidence.evals.comparisonInventory?.slice(0, 5) ?? [],
    },
    coverage,
  };
}

async function readCollectionManifestSummary(
  manifestPath: string,
): Promise<TrainingCollectionRunSummary | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (!isTrainingCollectionManifest(parsed)) return null;
    return summarizeCollectionManifest(parsed);
  } catch {
    return null;
  }
}

async function discoverCollectionManifestPaths(
  root: string,
): Promise<string[]> {
  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) return [];
  } catch {
    return [];
  }

  const paths = new Set<string>();
  const rootManifest = join(root, "collection-manifest.json");
  if (existsSync(rootManifest)) {
    paths.add(rootManifest);
  }

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, entry.name, "collection-manifest.json");
    if (existsSync(manifestPath)) {
      paths.add(manifestPath);
    }
  }
  return [...paths];
}

export async function listTrainingCollections(
  options: ListTrainingCollectionsOptions = {},
): Promise<ListTrainingCollectionsResult> {
  const root = resolve(
    options.root ?? join(trainingStateRoot(), "collections"),
  );
  const indexJsonPath = join(root, "collection-index.json");
  const indexHtmlPath = join(root, "collection-index.html");
  const limit =
    typeof options.limit === "number" && Number.isFinite(options.limit)
      ? Math.max(1, Math.floor(options.limit))
      : 20;
  const summaries = (
    await Promise.all(
      (
        await discoverCollectionManifestPaths(root)
      ).map((manifestPath) => readCollectionManifestSummary(manifestPath)),
    )
  ).filter((summary): summary is TrainingCollectionRunSummary => !!summary);

  summaries.sort((a, b) => {
    const generatedDelta =
      Date.parse(b.generatedAt) - Date.parse(a.generatedAt);
    if (Number.isFinite(generatedDelta) && generatedDelta !== 0) {
      return generatedDelta;
    }
    return b.outputDir.localeCompare(a.outputDir);
  });

  return {
    root,
    indexJsonPath,
    indexHtmlPath,
    collections: summaries.slice(0, limit),
  };
}

function buildCollectionIndexHtml(index: TrainingCollectionIndex): string {
  const rows = index.collections
    .map((collection) => {
      const sourceSummary = [
        `hf:${collection.dataSources.huggingFaceDatasets}`,
        `feed:${collection.dataSources.feedDatasets}`,
        `natural:${collection.dataSources.naturalTrajectoryBundles}`,
        `scenarios:${collection.dataSources.scenarioRuns}`,
        `native:${collection.dataSources.scenarioNativeDatasets}`,
        `tests:${collection.dataSources.testTrajectories}`,
        `jsonl:${collection.dataSources.trainingJsonlDatasets}`,
      ].join(" ");
      const sourceLinks =
        collection.sourceArtifacts.length > 0
          ? collection.sourceArtifacts
              .slice(0, 6)
              .map(
                (artifact) =>
                  `<a href="${escapeHtml(fileHref(artifact.path))}">${escapeHtml(`${artifact.category}:${artifact.title}`)}</a>`,
              )
              .join(" ")
          : "<span>no source artifacts</span>";
      const sourceSampleRows = [
        ["hf", collection.sourceSamples.huggingFace],
        ["feed", collection.sourceSamples.feed],
        ["natural", collection.sourceSamples.natural],
        ["scenarios", collection.sourceSamples.scenarios],
        ["tests", collection.sourceSamples.tests],
        ["jsonl", collection.sourceSamples.trainingJsonl],
      ].flatMap(([category, samples]) =>
        (samples as TrainingCollectionSourceSample[])
          .slice(0, 2)
          .map((sample) =>
            [
              category,
              sample.trajectoryId ?? sample.scenarioId ?? sample.title,
              sample.task ?? sample.sourceKind ?? sample.schema ?? "sample",
              `input:${compactCollectionIndexValue(sample.input) || "n/a"}`,
              `output:${compactCollectionIndexValue(sample.output) || "n/a"}`,
            ].join(" "),
          ),
      );
      const sourceSampleSummary =
        sourceSampleRows.length > 0 ? sourceSampleRows.join(" | ") : "none";
      const gapSummary =
        collection.readinessGaps.length > 0
          ? collection.readinessGaps
              .slice(0, 4)
              .map((gap) =>
                [
                  `${gap.id}:${gap.status}`,
                  gap.recommendedCapability
                    ? `->${gap.recommendedCapability}`
                    : null,
                  gap.recommendedParams
                    ? ` params=${JSON.stringify(gap.recommendedParams)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(""),
              )
              .join(" | ")
          : "none";
      const benchmarkSummary = [
        `pairs:${collection.benchmarks.actionBenchmarkPairs}`,
        `comparisons:${collection.benchmarks.benchmarkComparisons}`,
        `cases:${collection.benchmarks.caseSamples}`,
        `tiers:${collection.benchmarks.tiers.join(",") || "none"}`,
      ].join(" ");
      const baselineSummary = [
        `established:${collection.benchmarks.baselineProgress.establishedTiers.join(",") || "none"}`,
        `next:${collection.benchmarks.baselineProgress.nextTier ?? "none"}`,
        `remaining:${collection.benchmarks.baselineProgress.remainingTiers.join(",") || "none"}`,
      ].join(" ");
      const benchmarkHighlights =
        collection.benchmarks.comparisonInventory.length > 0
          ? collection.benchmarks.comparisonInventory
              .slice(0, 3)
              .map((comparison) =>
                [
                  comparison.tier ?? "tier",
                  comparison.benchmark ?? "benchmark",
                  `base:${comparison.baseScore ?? "n/a"}`,
                  `trained:${comparison.trainedScore ?? "n/a"}`,
                  `reference:${comparison.referenceScore ?? "n/a"}`,
                  `improvement:${comparison.improvementPercent ?? "n/a"}%`,
                  `vs-reference:${comparison.trainedVsReferencePercent ?? "n/a"}%`,
                  comparison.dryRun
                    ? "dry-run"
                    : comparison.modelBacked
                      ? "model-backed"
                      : comparison.useMocks
                        ? "mocked"
                        : "unverified",
                ].join(" "),
              )
              .join(" | ")
          : "none";
      const benchmarkLinks =
        collection.evidenceArtifacts.filter(
          (artifact) => artifact.category === "benchmark",
        ).length > 0
          ? collection.evidenceArtifacts
              .filter((artifact) => artifact.category === "benchmark")
              .slice(0, 4)
              .map(
                (artifact) =>
                  `<a href="${escapeHtml(fileHref(artifact.path))}">${escapeHtml(`${artifact.category}:${artifact.title}`)}</a>`,
              )
              .join(" ")
          : "<span>no benchmark artifacts</span>";
      const evalSummary = [
        `evals:${collection.evals.evalArtifacts}`,
        `comparisons:${collection.evals.evalComparisons}`,
        `action:${collection.evals.actionBenchmarks}`,
        `matrices:${collection.evals.benchmarkMatrices}`,
      ].join(" ");
      const evalLinks =
        collection.evidenceArtifacts.filter(
          (artifact) => artifact.category === "eval",
        ).length > 0
          ? collection.evidenceArtifacts
              .filter((artifact) => artifact.category === "eval")
              .slice(0, 4)
              .map(
                (artifact) =>
                  `<a href="${escapeHtml(fileHref(artifact.path))}">${escapeHtml(`${artifact.category}:${artifact.title}`)}</a>`,
              )
              .join(" ")
          : "<span>no eval artifacts</span>";
      const modelSummary = [
        `runs:${collection.training.trainingRuns}`,
        `models:${collection.training.models}`,
        `inventory:${collection.training.modelInventory.length}`,
        `tracked:${collection.coverage.models.inventoryCount}`,
      ].join(" ");
      const modelHighlights =
        collection.training.modelInventory.length > 0
          ? collection.training.modelInventory
              .slice(0, 3)
              .map((model) =>
                [
                  model.tier ?? "tier",
                  model.variant ?? "variant",
                  model.model ?? "model",
                  `base:${model.baseModel ?? "n/a"}`,
                  `output:${model.outputPath ?? "n/a"}`,
                  `improvement:${model.evalImprovementPercent ?? "n/a"}%`,
                ].join(" "),
              )
              .join(" | ")
          : "none";
      const modelLinks =
        collection.evidenceArtifacts.filter(
          (artifact) => artifact.category === "model",
        ).length > 0
          ? collection.evidenceArtifacts
              .filter((artifact) => artifact.category === "model")
              .slice(0, 4)
              .map(
                (artifact) =>
                  `<a href="${escapeHtml(fileHref(artifact.path))}">${escapeHtml(`${artifact.category}:${artifact.title}`)}</a>`,
              )
              .join(" ")
          : "<span>no model artifacts</span>";
      const coverageSummary = [
        `samples:${collection.coverage.readableSamples.total}`,
        `scored-evals:${collection.coverage.evals.scoredComparisons}/${collection.coverage.evals.comparisons}`,
        `scored-bench:${collection.coverage.benchmarks.scoredComparisons}/${collection.coverage.benchmarks.comparisons}`,
        `all-tiers:${collection.coverage.benchmarks.allEliza1TiersCovered ? "yes" : "no"}`,
      ].join(" ");
      return `<tr>
        <td>${escapeHtml(collection.generatedAt)}</td>
        <td>${escapeHtml(collection.readinessStatus)}<br><span>${escapeHtml(`ready:${collection.readiness.ready} partial:${collection.readiness.partial} missing:${collection.readiness.missing}`)}</span></td>
        <td>${escapeHtml(gapSummary)}</td>
        <td>${escapeHtml(sourceSummary)}<br><span>${escapeHtml(sourceSampleSummary)}</span><br>${sourceLinks}</td>
        <td>${escapeHtml(`${benchmarkSummary} ${baselineSummary}`)}<br><span>${escapeHtml(benchmarkHighlights)}</span><br>${benchmarkLinks}</td>
        <td>${escapeHtml(evalSummary)}<br>${evalLinks}</td>
        <td>${escapeHtml(modelSummary)}<br><span>${escapeHtml(modelHighlights)}</span><br>${modelLinks}</td>
        <td>${escapeHtml(coverageSummary)}</td>
        <td>${escapeHtml(collection.artifactCount)}</td>
        <td><a href="${escapeHtml(fileHref(collection.analysisIndexHtmlPath))}">viewer</a> <a href="${escapeHtml(fileHref(collection.readmePath))}">readme</a> <a href="${escapeHtml(fileHref(collection.manifestPath))}">manifest</a></td>
        <td><code>${escapeHtml(collection.outputDir)}</code></td>
      </tr>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Eliza Training Collections</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; color: #111827; background: #f8fafc; }
    main { max-width: 1200px; margin: 0 auto; padding: 32px 20px; }
    h1 { margin: 0 0 6px; font-size: 28px; }
    .meta { color: #64748b; font-size: 13px; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dbe3ef; }
    th, td { border-bottom: 1px solid #e5edf7; padding: 10px; text-align: left; vertical-align: top; font-size: 13px; }
    th { background: #eef3f8; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #475569; }
    tr:hover { background: #f8fbff; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
    a { color: #0f766e; margin-right: 8px; }
    span { color: #64748b; }
  </style>
</head>
<body>
  <main>
    <h1>Eliza Training Collections</h1>
    <div class="meta">Generated ${escapeHtml(index.generatedAt)} · root <code>${escapeHtml(index.root)}</code> · ${index.collections.length} runs · <a href="${escapeHtml(fileHref(index.indexJsonPath))}">JSON index</a></div>
    <table>
      <thead>
        <tr>
          <th>Generated</th>
          <th>Readiness</th>
          <th>Gaps</th>
          <th>Sources</th>
          <th>Benchmarks</th>
          <th>Evals</th>
          <th>Models</th>
          <th>Coverage</th>
          <th>Artifacts</th>
          <th>Links</th>
          <th>Output</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="11">No collection runs found.</td></tr>'}
      </tbody>
    </table>
  </main>
</body>
</html>
`;
}

export async function writeTrainingCollectionIndex(
  options: ListTrainingCollectionsOptions & { generatedAt?: string } = {},
): Promise<TrainingCollectionIndex> {
  const listed = await listTrainingCollections(options);
  await mkdir(listed.root, { recursive: true });
  const index: TrainingCollectionIndex = {
    schema: TRAINING_COLLECTION_INDEX_SCHEMA,
    schemaVersion: TRAINING_COLLECTION_INDEX_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    root: listed.root,
    indexJsonPath: listed.indexJsonPath,
    indexHtmlPath: listed.indexHtmlPath,
    collections: listed.collections,
  };
  await writeFile(
    index.indexJsonPath,
    `${JSON.stringify(index, null, 2)}\n`,
    "utf8",
  );
  await writeFile(index.indexHtmlPath, buildCollectionIndexHtml(index), "utf8");
  return index;
}

function buildCollectionReadme(
  manifest: TrainingCollectionRunManifest,
): string {
  const evidence = manifest.evidence;
  const sourceSamples = evidence.sourceSamples;
  const coverage = collectionCoverage(evidence);
  const sampleCounts = [
    ["Hugging Face", sourceSamples.huggingFace.length],
    ["Feed", sourceSamples.feed.length],
    ["Natural", sourceSamples.natural.length],
    ["Scenarios", sourceSamples.scenarios.length],
    ["Tests", sourceSamples.tests.length],
    ["Training JSONL", sourceSamples.trainingJsonl.length],
  ];
  const sampleRows = (
    [
      ["Hugging Face", sourceSamples.huggingFace],
      ["Feed", sourceSamples.feed],
      ["Natural", sourceSamples.natural],
      ["Scenarios", sourceSamples.scenarios],
      ["Tests", sourceSamples.tests],
      ["Training JSONL", sourceSamples.trainingJsonl],
    ] as const
  ).flatMap(([source, samples]) =>
    samples
      .slice(0, 6)
      .map((sample) => [
        source,
        sample.title,
        sample.task ?? sample.scenarioId ?? sample.sourceKind,
        sample.trajectoryId,
        sample.model,
        sample.input,
        sample.output,
        markdownPathLink(sample.path),
      ]),
  );
  const benchmarkReadiness = evidence.benchmarkReadiness;
  const baselineProgress = evidence.benchmarks.baselineProgress;
  const preflightRows = evidence.preflight.checks.map((check) => [
    check.status,
    check.id,
    check.label,
    check.detail,
    markdownPathLink(check.path),
  ]);
  const modelRows = evidence.training.modelInventory
    .slice(0, 12)
    .map((model) => [
      model.tier,
      model.variant,
      model.model,
      model.baseModel,
      model.baseEvalScore,
      model.trainedEvalScore,
      markdownPathLink(model.outputPath),
      model.evalImprovementPercent,
    ]);
  const comparisonRows = evidence.benchmarks.comparisonInventory
    .slice(0, 12)
    .map((comparison) => [
      comparison.tier,
      comparison.benchmark,
      comparison.baseScore,
      comparison.trainedScore,
      comparison.referenceScore,
      comparison.improvementPercent,
      comparison.trainedVsReferencePercent,
      comparison.dryRun
        ? "dry-run"
        : comparison.modelBacked
          ? "model-backed"
          : comparison.useMocks
            ? "mocked"
            : "unverified",
    ]);
  const evalComparisonRows = evidence.evals.comparisonInventory
    .slice(0, 12)
    .map((comparison) => [
      comparison.baseModel,
      comparison.trainedModel,
      comparison.backend,
      comparison.baseScore,
      comparison.trainedScore,
      comparison.improvementPercent,
      comparison.baseLatencyMs,
      comparison.trainedLatencyMs,
      markdownPathLink(comparison.reportPath),
    ]);
  const caseRows = evidence.benchmarks.caseSamples
    .slice(0, 12)
    .map((sample) => [
      sample.tier,
      sample.variant,
      sample.caseId,
      sample.pass,
      sample.prompt,
      sample.expectedAction,
      sample.actualAction,
      markdownPathLink(sample.trajectoryPath),
    ]);
  const gapRows = evidence.readinessGaps.map((gap) => [
    gap.status,
    gap.id,
    gap.note,
    gap.recommendedCapability,
    gap.recommendedParams,
  ]);
  const artifactRows = evidence.artifactLinks
    .slice(0, 24)
    .map((artifact) => [
      artifact.category,
      artifact.kind,
      artifact.schema,
      artifact.title,
      markdownPathLink(artifact.path),
    ]);
  const stepArtifactRows = evidence.stepArtifacts.flatMap((step) => {
    const command = step.command?.join(" ") ?? null;
    if (step.paths.length === 0) {
      return [
        [
          step.stepId,
          step.status,
          command,
          step.exitCode,
          step.stdout,
          step.stderr,
          "n/a",
          markdownPathLink(step.outputDir),
        ],
      ];
    }
    return step.paths
      .slice(0, 8)
      .map((path) => [
        step.stepId,
        step.status,
        command,
        step.exitCode,
        step.stdout,
        step.stderr,
        path.label,
        markdownPathLink(path.path),
      ]);
  });

  return `# Eliza Training Collection

Generated: ${manifest.generatedAt}

## Entry Points

- Output directory: ${markdownPathLink(manifest.outputDir)}
- Collection manifest: ${markdownPathLink(manifest.manifestPath)}
- Run summary: ${markdownPathLink(manifest.readmePath)}
- Analysis viewer: ${markdownPathLink(manifest.analysis.indexHtmlPath)}
- Analysis manifest: ${markdownPathLink(manifest.analysis.manifestPath)}
- Readiness report: ${markdownPathLink(manifest.readiness.reportPath)}

## Provenance

- Generated by: ${manifest.provenance.generatedBy}
- Workspace root: ${manifest.provenance.workspaceRoot ?? "n/a"}
- Training state root: ${manifest.provenance.trainingStateRoot}
- Analysis roots: ${manifest.provenance.analysisRoots.join(", ")}
- Output layout: collection=${manifest.provenance.outputLayout.collection} analysis=${manifest.provenance.outputLayout.analysis} steps=${manifest.provenance.outputLayout.steps}

## Readiness

- Status: ${manifest.readiness.status}
- Checks: ready=${manifest.readiness.ready} partial=${manifest.readiness.partial} missing=${manifest.readiness.missing}
- Benchmark readiness: smallest=${benchmarkReadiness.smallestTier} all-tiers=${benchmarkReadiness.allEliza1Tiers} improvement=${benchmarkReadiness.baseTrainedImprovement} all-tier-improvements=${benchmarkReadiness.allEliza1TierImprovements} cerebras=${benchmarkReadiness.cerebrasReference}

## Live Preflight

- Live work requested: ${evidence.preflight.liveRequired ? "yes" : "no"}

${markdownTable(["Status", "Check", "Label", "Detail", "Path"], preflightRows)}

## Coverage

- Data sources: hf=${coverage.dataSources.huggingFace} feed=${coverage.dataSources.feed} natural=${coverage.dataSources.natural} scenarios=${coverage.dataSources.scenarios} tests=${coverage.dataSources.tests} jsonl=${coverage.dataSources.trainingJsonl}
- Readable samples: total=${coverage.readableSamples.total} hf=${coverage.readableSamples.huggingFace} feed=${coverage.readableSamples.feed} natural=${coverage.readableSamples.natural} scenarios=${coverage.readableSamples.scenarios} tests=${coverage.readableSamples.tests} jsonl=${coverage.readableSamples.trainingJsonl}
- Eval comparisons: scored=${coverage.evals.scoredComparisons}/${coverage.evals.comparisons} artifacts=${coverage.evals.artifacts}
- Benchmark comparisons: scored=${coverage.benchmarks.scoredComparisons}/${coverage.benchmarks.comparisons} matrices=${coverage.benchmarks.matrices} case-samples=${coverage.benchmarks.caseSamples} all-tiers=${coverage.benchmarks.allEliza1TiersCovered ? "yes" : "no"}
- Benchmark tiers: ${coverage.benchmarks.tiers.join(", ") || "none"}
- Model inventory: artifacts=${coverage.models.artifacts} inventory=${coverage.models.inventoryCount} staged-bundles=${coverage.models.stagedBundles}

## Baseline Progression

- Tier order: ${baselineProgress.tierOrder.join(" -> ")}
- Established tiers: ${baselineProgress.establishedTiers.join(", ") || "none"}
- Remaining tiers: ${baselineProgress.remainingTiers.join(", ") || "none"}
- Next tier: ${baselineProgress.nextTier ?? "none"}
- Smallest tier established: ${baselineProgress.smallestTierEstablished ? "yes" : "no"}
- All tiers established: ${baselineProgress.allTiersEstablished ? "yes" : "no"}

## Steps

${markdownTable(
  ["Step", "Status", "Output", "Error"],
  manifest.steps.map((step) => [
    step.id,
    step.status,
    markdownPathLink(step.outputDir),
    step.error,
  ]),
)}
## Step Artifacts

${markdownTable(
  [
    "Step",
    "Status",
    "Command",
    "Exit",
    "Stdout",
    "Stderr",
    "Path Label",
    "Path",
  ],
  stepArtifactRows,
)}
## Data Sources

${markdownTable(
  ["Source", "Count"],
  [
    ["Hugging Face datasets", evidence.dataSources.huggingFaceDatasets],
    ["Feed datasets", evidence.dataSources.feedDatasets],
    [
      "Natural trajectory bundles",
      evidence.dataSources.naturalTrajectoryBundles,
    ],
    ["Scenario runs", evidence.dataSources.scenarioRuns],
    ["Scenario native datasets", evidence.dataSources.scenarioNativeDatasets],
    ["Test trajectories", evidence.dataSources.testTrajectories],
    ["Training JSONL datasets", evidence.dataSources.trainingJsonlDatasets],
  ],
)}
## Source Samples

${markdownTable(["Source", "Samples"], sampleCounts)}
## Source Sample Preview

${markdownTable(
  ["Source", "Title", "Task", "Trajectory", "Model", "Input", "Output", "Path"],
  sampleRows,
)}
## Model Inventory

${markdownTable(
  [
    "Tier",
    "Variant",
    "Model",
    "Base Model",
    "Base Score",
    "Trained Score",
    "Output",
    "Eval Improvement %",
  ],
  modelRows,
)}
## Benchmark Comparisons

${markdownTable(
  [
    "Tier",
    "Benchmark",
    "Base",
    "Trained",
    "Reference",
    "Improvement %",
    "Vs Reference %",
    "Evidence",
  ],
  comparisonRows,
)}
## Eval Comparisons

${markdownTable(
  [
    "Base Model",
    "Trained Model",
    "Backend",
    "Base Score",
    "Trained Score",
    "Improvement %",
    "Base Latency",
    "Trained Latency",
    "Report",
  ],
  evalComparisonRows,
)}
## Benchmark Case Samples

${markdownTable(
  [
    "Tier",
    "Variant",
    "Case",
    "Pass",
    "Input",
    "Expected",
    "Actual",
    "Trajectory",
  ],
  caseRows,
)}
## Readiness Gaps

${markdownTable(["Status", "Check", "Note", "Recommended Capability", "Recommended Params"], gapRows)}
## Evidence Artifacts

${markdownTable(["Category", "Kind", "Schema", "Title", "Path"], artifactRows)}
`;
}

async function writeCollectionReadme(
  manifest: TrainingCollectionRunManifest,
): Promise<string> {
  const readmePath = join(manifest.outputDir, "README.md");
  await writeFile(readmePath, buildCollectionReadme(manifest), "utf8");
  return readmePath;
}

async function runStep<T>(
  id: TrainingCollectionStep<T>["id"],
  enabled: boolean,
  outputDir: string,
  run: (outputDir: string) => Promise<T & { outputDir?: string }>,
): Promise<TrainingCollectionStep<T>> {
  if (!enabled) {
    return {
      id,
      status: "skipped",
      outputDir: null,
      error: null,
      result: null,
    };
  }
  const dir = stepOutputDir(outputDir, id);
  try {
    const result = await run(dir);
    return {
      id,
      status: "succeeded",
      outputDir: result.outputDir ?? dir,
      error: null,
      result,
    };
  } catch (err) {
    return {
      id,
      status: "failed",
      outputDir: dir,
      error: err instanceof Error ? err.message : String(err),
      result: null,
    };
  }
}

export async function runTrainingCollection(
  options: TrainingCollectionRunOptions = {},
): Promise<TrainingCollectionRunResult> {
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const stateRoot = trainingStateRoot();
  const outputDir =
    options.outputDir ??
    join(stateRoot, "collections", safeTimestamp(generatedAt));
  const workspaceRoot = options.workspaceRoot
    ? resolve(options.workspaceRoot)
    : discoverWorkspaceRoot();
  const trainingRoot = workspaceRoot
    ? join(workspaceRoot, "packages", "training")
    : undefined;
  await mkdir(outputDir, { recursive: true });

  const steps: TrainingCollectionStep[] = [];
  steps.push(
    await runStep<HuggingFaceDatasetIngestResult>(
      "huggingface",
      boolWithDefault(options.includeHuggingFace, true),
      outputDir,
      (dir) =>
        ingestHuggingFaceDataset({
          ...(options.huggingFace ?? {}),
          outputDir: options.huggingFace?.outputDir ?? dir,
        }),
    ),
  );
  steps.push(
    await runStep<FeedGenerationRunResult>(
      "feed",
      boolWithDefault(options.includeFeed, true),
      outputDir,
      (dir) =>
        runFeedGeneration({
          ...(options.feed ?? {}),
          workspaceRoot: options.feed?.workspaceRoot ?? workspaceRoot,
          outputDir: options.feed?.outputDir ?? dir,
        }),
    ),
  );
  steps.push(
    await runStep<TrajectoryExportBundle>(
      "natural_trajectories",
      boolWithDefault(options.includeNaturalTrajectories, false),
      outputDir,
      (dir) =>
        buildTrajectoryExportBundle({
          ...(options.naturalTrajectories ?? {}),
          outputDir: options.naturalTrajectories?.outputDir ?? dir,
          source: {
            kind: "training_collection_natural_trajectories",
            ...(options.naturalTrajectories?.source ?? {}),
          },
        }),
    ),
  );
  steps.push(
    await runStep<TestTrajectoryCollectionResult>(
      "test_trajectories",
      boolWithDefault(options.includeTestTrajectories, false),
      outputDir,
      (dir) =>
        collectTestTrajectories({
          ...(options.testTrajectories ?? {}),
          workspaceRoot:
            options.testTrajectories?.workspaceRoot ?? workspaceRoot,
          outputDir: options.testTrajectories?.outputDir ?? dir,
          generatedAt: options.testTrajectories?.generatedAt ?? generatedAt,
          syntheticFallback:
            options.testTrajectories?.syntheticFallback ?? true,
        }),
    ),
  );
  steps.push(
    await runStep<ScenarioRunResult>(
      "scenarios",
      boolWithDefault(options.includeScenarios, true),
      outputDir,
      (dir) =>
        runScenarios({
          ...(options.scenarios ?? {}),
          workspaceRoot: options.scenarios?.workspaceRoot ?? workspaceRoot,
          outputDir: options.scenarios?.outputDir ?? dir,
        }),
    ),
  );
  steps.push(
    await runStep<EvalComparisonRunResult>(
      "eval_comparison",
      boolWithDefault(options.includeEvalComparison, false),
      outputDir,
      (dir) =>
        runLocalEvalComparison({
          ...(options.evalComparison ?? {}),
          trainingRoot: options.evalComparison?.trainingRoot ?? trainingRoot,
          outputDir: options.evalComparison?.outputDir ?? dir,
        }),
    ),
  );
  steps.push(
    await runStep<ActionBenchmarkRunResult | ActionBenchmarkPairRunResult>(
      "action_benchmark",
      boolWithDefault(options.includeActionBenchmark, true),
      outputDir,
      (dir) =>
        runActionBenchmarkCollectionStep({
          outputDir: dir,
          workspaceRoot,
          options,
        }),
    ),
  );
  steps.push(
    await runStep<BenchmarkVsCerebrasRunResult>(
      "benchmark_vs_cerebras",
      boolWithDefault(options.includeBenchmarkVsCerebras, false),
      outputDir,
      (dir) =>
        runBenchmarkVsCerebras({
          ...(options.benchmarkVsCerebras ?? {}),
          trainingRoot:
            options.benchmarkVsCerebras?.trainingRoot ?? trainingRoot,
          outputDir: options.benchmarkVsCerebras?.outputDir ?? dir,
          matrixOutputDir:
            options.benchmarkVsCerebras?.matrixOutputDir ?? join(dir, "matrix"),
        }),
    ),
  );
  steps.push(
    await runStep<Eliza1ModelRegistryResult>(
      "eliza1_model_registry",
      boolWithDefault(options.includeEliza1ModelRegistry, true),
      outputDir,
      (dir) =>
        writeEliza1ModelRegistryArtifacts({
          outputDir: dir,
          generatedAt,
        }),
    ),
  );
  steps.push(
    await runStep<StageEliza1BundleResult>(
      "eliza1_bundle_stage",
      boolWithDefault(options.includeEliza1BundleStage, false),
      outputDir,
      (dir) =>
        stageEliza1Bundle({
          ...(options.eliza1BundleStage ?? {}),
          trainingRoot: options.eliza1BundleStage?.trainingRoot ?? trainingRoot,
          outputDir: options.eliza1BundleStage?.outputDir ?? dir,
        }),
    ),
  );
  steps.push(
    await runStep<BenchmarkMatrixArtifactResult>(
      "benchmark_matrix",
      boolWithDefault(options.includeBenchmarkMatrix, true),
      outputDir,
      async (dir) => {
        const artifacts = autoBenchmarkMatrixSources(
          steps,
          options.benchmarkMatrix?.artifacts,
        );
        if (artifacts.length === 0) {
          throw new Error(
            "No benchmark artifacts available for benchmark matrix generation",
          );
        }
        return writeBenchmarkMatrixArtifactFromArtifacts({
          artifacts,
          outputDir: options.benchmarkMatrix?.outputDir ?? dir,
          generatedAt: options.benchmarkMatrix?.generatedAt ?? generatedAt,
          referenceModelId: options.benchmarkMatrix?.referenceModelId,
          source: options.benchmarkMatrix?.source ?? {
            kind: "training_collection_benchmark_matrix",
            collectionOutputDir: outputDir,
          },
        });
      },
    ),
  );

  const analysisRoots = [outputDir, ...(options.analysis?.roots ?? [])];
  let analysis = await buildTrainingAnalysisIndex({
    ...(options.analysis ?? {}),
    roots: analysisRoots,
    outputDir: options.analysis?.outputDir ?? join(outputDir, "analysis"),
  });
  const manifestPath = join(outputDir, "collection-manifest.json");
  const readmePath = join(outputDir, "README.md");
  const preflight = await buildTrainingCollectionPreflightWithProbes({
    options,
    workspaceRoot,
    trainingRoot,
  });
  const manifest: TrainingCollectionRunManifest = {
    schema: TRAINING_COLLECTION_RUN_SCHEMA,
    schemaVersion: TRAINING_COLLECTION_RUN_VERSION,
    generatedAt,
    outputDir,
    manifestPath,
    readmePath,
    provenance: {
      generatedBy: "plugin-training",
      workspaceRoot: workspaceRoot ?? null,
      trainingStateRoot: stateRoot,
      analysisRoots,
      outputLayout: {
        collection: outputDir,
        analysis: options.analysis?.outputDir ?? join(outputDir, "analysis"),
        steps: outputDir,
      },
    },
    recipe: buildCollectionRecipe(options),
    analysis: {
      outputDir: analysis.outputDir,
      indexHtmlPath: analysis.indexHtmlPath,
      manifestPath: analysis.manifestPath,
      artifactCount: analysis.manifest.counts.artifacts,
    },
    readiness: {
      outputDir: join(outputDir, "analysis"),
      reportPath: join(outputDir, "analysis", "training-readiness-report.json"),
      status: "missing",
      ready: 0,
      partial: 0,
      missing: 0,
    },
    evidence: {
      preflight,
      viewerHtmlPath: analysis.indexHtmlPath,
      analysisManifestPath: analysis.manifestPath,
      readinessReportPath: join(
        outputDir,
        "analysis",
        "training-readiness-report.json",
      ),
      artifactCounts: analysis.manifest.counts,
      coverage: {
        dataSources: analysis.manifest.coverage.dataSources,
        readableSamples: analysis.manifest.coverage.readableSamples,
        evals: analysis.manifest.coverage.evals,
        benchmarks: analysis.manifest.coverage.benchmarks,
        models: {
          artifacts: analysis.manifest.coverage.models.artifacts,
          stagedBundles: analysis.manifest.coverage.models.stagedBundles,
          inventoryCount: analysis.manifest.coverage.models.inventory.length,
        },
      },
      stepCounts: summarizeStepCounts(steps),
      stepArtifacts: summarizeStepArtifacts(steps),
      dataSources: {
        huggingFaceDatasets: 0,
        feedDatasets: 0,
        naturalTrajectoryBundles: 0,
        scenarioRuns: 0,
        scenarioNativeDatasets: 0,
        testTrajectories: 0,
        trainingJsonlDatasets: 0,
      },
      feed: { runs: [], archetypeStats: [], trajectorySamples: [] },
      sourceSamples: {
        huggingFace: [],
        feed: [],
        natural: [],
        scenarios: [],
        tests: [],
        trainingJsonl: [],
      },
      training: { trainingRuns: 0, models: 0, modelInventory: [] },
      evals: {
        evalArtifacts: 0,
        actionBenchmarks: 0,
        evalComparisons: 0,
        benchmarkMatrices: 0,
        comparisonInventory: [],
      },
      artifactLinks: [],
      benchmarks: {
        actionBenchmarkPairs: 0,
        actionBenchmarkMatrixSources: 0,
        benchmarkRows: 0,
        benchmarkComparisons: 0,
        tiers: [],
        comparisonInventory: [],
        improvementComparisons: [],
        baselineProgress: {
          tierOrder: [...ELIZA_ONE_BENCHMARK_TIERS],
          establishedTiers: [],
          remainingTiers: [...ELIZA_ONE_BENCHMARK_TIERS],
          nextTier: ELIZA_ONE_BENCHMARK_TIERS[0] ?? null,
          smallestTierEstablished: false,
          allTiersEstablished: false,
        },
        caseSamples: [],
      },
      benchmarkReadiness: {
        smallestTier: "missing",
        allEliza1Tiers: "missing",
        allEliza1TierImprovements: "missing",
        cerebrasReference: "missing",
        baseTrainedImprovement: "missing",
      },
      readinessGaps: [],
    },
    steps,
  };
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  analysis = await buildTrainingAnalysisIndex({
    ...(options.analysis ?? {}),
    roots: analysisRoots,
    outputDir: options.analysis?.outputDir ?? join(outputDir, "analysis"),
  });
  manifest.analysis = {
    outputDir: analysis.outputDir,
    indexHtmlPath: analysis.indexHtmlPath,
    manifestPath: analysis.manifestPath,
    artifactCount: analysis.manifest.counts.artifacts,
  };
  const readiness = await writeTrainingReadinessReport(analysis, {
    outputDir: analysis.outputDir,
    generatedAt,
  });
  manifest.readiness = {
    outputDir: readiness.outputDir,
    reportPath: readiness.reportPath,
    status: readiness.report.status,
    ready: readiness.report.counts.ready,
    partial: readiness.report.counts.partial,
    missing: readiness.report.counts.missing,
  };
  manifest.evidence = buildCollectionEvidenceSummary({
    analysis,
    readiness: readiness.report,
    steps,
    preflight: manifest.evidence.preflight,
  });
  analysis = await buildTrainingAnalysisIndex({
    ...(options.analysis ?? {}),
    roots: analysisRoots,
    outputDir: options.analysis?.outputDir ?? join(outputDir, "analysis"),
  });
  manifest.analysis = {
    outputDir: analysis.outputDir,
    indexHtmlPath: analysis.indexHtmlPath,
    manifestPath: analysis.manifestPath,
    artifactCount: analysis.manifest.counts.artifacts,
  };
  manifest.evidence = buildCollectionEvidenceSummary({
    analysis,
    readiness: readiness.report,
    steps,
    preflight: manifest.evidence.preflight,
  });
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeCollectionReadme(manifest);
  const collectionIndex = await writeTrainingCollectionIndex({
    root: dirname(outputDir),
    generatedAt,
  });
  return {
    outputDir,
    manifestPath,
    readmePath,
    collectionIndex,
    manifest,
    analysis,
  };
}
