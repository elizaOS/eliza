/**
 * Derives a training-readiness report from the analysis index: which tiers have
 * datasets, benchmarks, and eval coverage, and what action a caller must take
 * to close each gap. Emitted as a schema-tagged artifact for the dashboard.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ELIZA_ONE_BENCHMARK_TIER_LIST,
  ELIZA_ONE_BENCHMARK_TIERS,
  elizaOneActionBenchmarkPairs,
} from "./eliza1-benchmark-recipe.js";
import type {
  TrainingAnalysisArtifact,
  TrainingAnalysisCoverageSummary,
  TrainingAnalysisIndex,
} from "./training-analysis-index.js";

export const TRAINING_READINESS_REPORT_SCHEMA =
  "eliza_training_readiness_report";
export const TRAINING_READINESS_REPORT_VERSION = 1;
const ELIZA_HARNESS_ACTION_SELECTION_BENCHMARK =
  "eliza_harness_action_selection";

export type TrainingReadinessStatus = "ready" | "partial" | "missing";

export interface TrainingReadinessCheck {
  id: string;
  label: string;
  status: TrainingReadinessStatus;
  artifactCount: number;
  artifactPaths: string[];
  note: string;
  recommendedAction: TrainingReadinessAction | null;
}

export interface TrainingReadinessAction {
  label: string;
  capability: string;
  params: Record<string, unknown>;
}

export interface TrainingReadinessReport {
  schema: typeof TRAINING_READINESS_REPORT_SCHEMA;
  schemaVersion: typeof TRAINING_READINESS_REPORT_VERSION;
  generatedAt: string;
  outputDir: string;
  reportPath: string;
  analysisManifestPath: string;
  analysisIndexHtmlPath: string;
  status: TrainingReadinessStatus;
  counts: {
    checks: number;
    ready: number;
    partial: number;
    missing: number;
    artifacts: number;
  };
  checks: TrainingReadinessCheck[];
}

export interface TrainingReadinessReportResult {
  outputDir: string;
  reportPath: string;
  report: TrainingReadinessReport;
}

type ArtifactPredicate = (artifact: TrainingAnalysisArtifact) => boolean;
type ReadinessRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ReadinessRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaOf(artifact: TrainingAnalysisArtifact): string | undefined {
  const schema = artifact.summary.schema;
  return typeof schema === "string" ? schema : undefined;
}

function sourceKindOf(artifact: TrainingAnalysisArtifact): string | undefined {
  const source = artifact.summary.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }
  const kind = (source as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : undefined;
}

function sourceLabelOf(artifact: TrainingAnalysisArtifact): string | undefined {
  const source = artifact.summary.source;
  if (typeof source === "string") return source;
  return sourceKindOf(artifact);
}

function stringFromRecord(
  record: ReadinessRecord | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function benchmarkNameOf(
  artifact: TrainingAnalysisArtifact,
): string | undefined {
  const summarySource = isRecord(artifact.summary.source)
    ? artifact.summary.source
    : undefined;
  const payload = isRecord(artifact.payload) ? artifact.payload : undefined;
  const payloadSource = isRecord(payload?.source) ? payload.source : undefined;
  const payloadSummary = isRecord(payload?.summary)
    ? payload.summary
    : undefined;
  return (
    stringFromRecord(artifact.summary, "benchmark") ??
    stringFromRecord(summarySource, "benchmark") ??
    stringFromRecord(payload, "benchmark") ??
    stringFromRecord(payloadSource, "benchmark") ??
    stringFromRecord(payloadSummary, "benchmark")
  );
}

function isElizaHarnessActionBenchmark(
  artifact: TrainingAnalysisArtifact,
): boolean {
  return (
    schemaOf(artifact) === "eliza_action_selection_benchmark_report" ||
    sourceKindOf(artifact) === "app_core_action_selection_benchmark" ||
    benchmarkNameOf(artifact) === ELIZA_HARNESS_ACTION_SELECTION_BENCHMARK
  );
}

function numberSummary(
  artifact: TrainingAnalysisArtifact,
  key: string,
): number | undefined {
  const value = artifact.summary[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isDryRunArtifact(artifact: TrainingAnalysisArtifact): boolean {
  return (
    artifact.summary.dryRun === true ||
    (isRecord(artifact.payload) && artifact.payload.dryRun === true)
  );
}

function hasPositiveSummary(
  artifact: TrainingAnalysisArtifact,
  keys: readonly string[],
): boolean {
  return keys.some((key) => (numberSummary(artifact, key) ?? 0) > 0);
}

function hasReadableSamplePreview(artifact: TrainingAnalysisArtifact): boolean {
  const sampleKeys = [
    "samplePreviews",
    "feedSamplePreviews",
    "hfSamplePreviews",
    "scenarioNativeSamplePreviews",
    "testSamplePreviews",
  ];
  return sampleKeys.some((key) => {
    const samples = artifact.summary[key];
    return (
      Array.isArray(samples) &&
      samples.some((sample) => {
        if (!isRecord(sample)) return false;
        return (
          sample.input !== undefined ||
          sample.output !== undefined ||
          sample.trajectoryId !== undefined ||
          sample.scenarioId !== undefined ||
          sample.firstStep !== undefined ||
          sample.reasoning !== undefined
        );
      })
    );
  });
}

function normalizeTier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  if (normalized.includes("27b")) return "27b";
  if (normalized.includes("9b")) return "9b";
  if (normalized.includes("4b")) return "4b";
  if (normalized.includes("2b")) return "2b";
  return null;
}

function hasFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function matrixComparisons(
  artifact: TrainingAnalysisArtifact,
): ReadinessRecord[] {
  if (!isRecord(artifact.payload)) return [];
  const comparisons = artifact.payload.comparisons;
  return Array.isArray(comparisons) ? comparisons.filter(isRecord) : [];
}

function matrixRows(artifact: TrainingAnalysisArtifact): ReadinessRecord[] {
  if (!isRecord(artifact.payload)) return [];
  const rows = artifact.payload.rows;
  return Array.isArray(rows) ? rows.filter(isRecord) : [];
}

function hasBaseTrainedComparison(comparison: ReadinessRecord): boolean {
  return (
    comparison.dryRun !== true &&
    hasFiniteNumber(comparison.baseScore) &&
    hasFiniteNumber(comparison.trainedScore)
  );
}

function isMockedBenchmarkRecord(value: ReadinessRecord): boolean {
  const raw = isRecord(value.raw) ? value.raw : {};
  const rawSource = isRecord(raw.source) ? raw.source : {};
  const metrics = isRecord(value.metrics) ? value.metrics : {};
  return (
    value.useMocks === true ||
    raw.useMocks === true ||
    rawSource.useMocks === true ||
    metrics.useMocks === true
  );
}

function hasRealBenchmarkMatrixRows(
  artifact: TrainingAnalysisArtifact,
): boolean {
  return matrixRows(artifact).some(
    (row) => row.dryRun !== true && !isMockedBenchmarkRecord(row),
  );
}

function hasBenchmarkCaseProvenance(
  artifact: TrainingAnalysisArtifact,
): boolean {
  return matrixRows(artifact).some((row) => {
    if (row.dryRun === true || isMockedBenchmarkRecord(row)) return false;
    const raw = isRecord(row.raw) ? row.raw : {};
    const caseSamples = raw.caseSamples;
    if (!Array.isArray(caseSamples)) return false;
    return caseSamples.some((sample) => {
      if (!isRecord(sample)) return false;
      return (
        sample.pass === true &&
        typeof sample.caseId === "string" &&
        typeof sample.prompt === "string" &&
        typeof sample.expectedAction === "string" &&
        typeof sample.actualAction === "string" &&
        typeof sample.trajectoryPath === "string"
      );
    });
  });
}

function hasModelBackedRow(
  artifact: TrainingAnalysisArtifact,
  comparison: ReadinessRecord,
  variant: "base" | "trained",
): boolean {
  const tier = normalizeTier(comparison.tier);
  const benchmark =
    typeof comparison.benchmark === "string" ? comparison.benchmark : null;
  if (!tier || !benchmark) return false;
  return matrixRows(artifact).some((row) => {
    if (row.variant !== variant) return false;
    if (normalizeTier(row.tier) !== tier) return false;
    if (row.benchmark !== benchmark) return false;
    if (row.dryRun === true || isMockedBenchmarkRecord(row)) return false;
    return hasFiniteNumber(row.score);
  });
}

function hasModelBackedBaseTrainedComparison(
  artifact: TrainingAnalysisArtifact,
  comparison: ReadinessRecord,
): boolean {
  return (
    hasBaseTrainedComparison(comparison) &&
    hasModelBackedRow(artifact, comparison, "base") &&
    hasModelBackedRow(artifact, comparison, "trained")
  );
}

function modelBackedComparisonTierSet(
  artifact: TrainingAnalysisArtifact,
  predicate: (comparison: ReadinessRecord) => boolean,
): Set<string> {
  const out = new Set<string>();
  for (const comparison of matrixComparisons(artifact)) {
    if (!predicate(comparison)) continue;
    if (!hasModelBackedBaseTrainedComparison(artifact, comparison)) continue;
    const tier = normalizeTier(comparison.tier);
    if (tier) out.add(tier);
  }
  return out;
}

function hasImprovementComparison(artifact: TrainingAnalysisArtifact): boolean {
  return matrixComparisons(artifact).some(
    (comparison) =>
      hasModelBackedBaseTrainedComparison(artifact, comparison) &&
      hasFiniteNumber(comparison.improvementPercent),
  );
}

function hasScoredEvalImprovement(artifact: TrainingAnalysisArtifact): boolean {
  return (
    hasFiniteNumber(artifact.summary.baseScore) &&
    hasFiniteNumber(artifact.summary.trainedScore) &&
    hasFiniteNumber(artifact.summary.improvementPercent)
  );
}

function hasImprovementComparisonRecord(comparison: ReadinessRecord): boolean {
  return (
    hasBaseTrainedComparison(comparison) &&
    hasFiniteNumber(comparison.improvementPercent)
  );
}

function hasSmallestTierComparison(
  artifact: TrainingAnalysisArtifact,
): boolean {
  return modelBackedComparisonTierSet(artifact, hasBaseTrainedComparison).has(
    "2b",
  );
}

function hasAllEliza1BenchmarkTierComparisons(
  artifact: TrainingAnalysisArtifact,
): boolean {
  const tiers = modelBackedComparisonTierSet(
    artifact,
    hasBaseTrainedComparison,
  );
  return ELIZA_ONE_BENCHMARK_TIERS.every((tier) => tiers.has(tier));
}

function hasAllEliza1TierImprovementComparisons(
  artifact: TrainingAnalysisArtifact,
): boolean {
  const tiers = modelBackedComparisonTierSet(
    artifact,
    hasImprovementComparisonRecord,
  );
  return ELIZA_ONE_BENCHMARK_TIERS.every((tier) => tiers.has(tier));
}

function actionBenchmarkPairCollectionAction(
  label: string,
  tiers: readonly string[],
): TrainingReadinessAction {
  return {
    label,
    capability: "terminal-training-run-collection",
    params: {
      includeActionBenchmark: true,
      includeBenchmarkMatrix: true,
      actionBenchmark: {
        dryRun: false,
        useMocks: false,
        runsPerCase: 1,
        provider: "local-llama-cpp",
        benchmark: "eliza_harness_action_selection",
        datasetVersion: "eliza-native-v1",
      },
      actionBenchmarkPairs: elizaOneActionBenchmarkPairs(tiers),
    },
  };
}

function hasCerebrasReferenceComparison(
  artifact: TrainingAnalysisArtifact,
): boolean {
  const summaryReference = artifact.summary.referenceModelId;
  const hasSummaryReference =
    typeof summaryReference === "string" && /cerebras/i.test(summaryReference);
  return matrixComparisons(artifact).some((comparison) => {
    const reference = comparison.referenceModelId;
    const hasComparisonReference =
      typeof reference === "string" && /cerebras/i.test(reference);
    return (
      hasFiniteNumber(comparison.referenceScore) &&
      (hasSummaryReference || hasComparisonReference)
    );
  });
}

function modelVariantOf(artifact: TrainingAnalysisArtifact): string | null {
  const payload = isRecord(artifact.payload) ? artifact.payload : {};
  const variant = payload.variant;
  if (variant === "base" || variant === "trained") return variant;
  const summaryModel = artifact.summary.model;
  const model =
    typeof summaryModel === "string"
      ? summaryModel
      : typeof payload.modelId === "string"
        ? payload.modelId
        : typeof payload.model_name === "string"
          ? payload.model_name
          : typeof payload.model === "string"
            ? payload.model
            : "";
  if (/-base\b/.test(model)) return "base";
  if (/-trained\b/.test(model)) return "trained";
  return null;
}

function modelTierOf(artifact: TrainingAnalysisArtifact): string | null {
  const payload = isRecord(artifact.payload) ? artifact.payload : {};
  return (
    normalizeTier(artifact.summary.tier) ??
    normalizeTier(payload.tier) ??
    normalizeTier(artifact.summary.model) ??
    normalizeTier(payload.modelId) ??
    normalizeTier(payload.model_name) ??
    normalizeTier(payload.model)
  );
}

function hasModelOutputEvidence(artifact: TrainingAnalysisArtifact): boolean {
  return (
    artifact.kind === "model" &&
    (typeof artifact.summary.outputPath === "string" ||
      artifact.summary.apply === true ||
      (numberSummary(artifact, "stagedCount") ?? 0) > 0)
  );
}

function buildModelTrackingCheck(
  artifacts: readonly TrainingAnalysisArtifact[],
  coverage?: TrainingAnalysisCoverageSummary,
): TrainingReadinessCheck {
  const coverageModels = coverage?.models;
  if (coverageModels && coverageModels.inventory.length > 0) {
    const coverageSet = new Set<string>();
    for (const model of coverageModels.inventory) {
      if (model.tier && model.variant) {
        coverageSet.add(`${model.tier}:${model.variant}`);
      }
    }
    const hasAllEliza1Variants = ELIZA_ONE_BENCHMARK_TIERS.every(
      (tier) =>
        coverageSet.has(`${tier}:base`) && coverageSet.has(`${tier}:trained`),
    );
    if (hasAllEliza1Variants) {
      return {
        id: "model_tracking",
        label: "Model tracking",
        status: "ready",
        artifactCount: coverageModels.artifacts,
        artifactPaths: artifacts
          .filter((artifact) => artifact.kind === "model")
          .map((artifact) => artifact.path),
        note: "Analysis coverage includes base and trained Eliza-1 model entries for every tier.",
        recommendedAction: null,
      };
    }
  }
  const modelArtifacts = artifacts.filter(
    (artifact) => artifact.kind === "model",
  );
  const registryArtifacts = modelArtifacts.filter(hasModelOutputEvidence);
  const modelCoverage = new Set<string>();
  for (const artifact of registryArtifacts) {
    const tier = modelTierOf(artifact);
    const variant = modelVariantOf(artifact);
    if (tier && variant) modelCoverage.add(`${tier}:${variant}`);
  }
  const hasAllEliza1Variants = ELIZA_ONE_BENCHMARK_TIERS.every(
    (tier) =>
      modelCoverage.has(`${tier}:base`) && modelCoverage.has(`${tier}:trained`),
  );
  const appliedBundleArtifacts = modelArtifacts.filter(
    (artifact) =>
      artifact.summary.apply === true ||
      (numberSummary(artifact, "stagedCount") ?? 0) > 0,
  );
  const readyArtifacts = hasAllEliza1Variants
    ? registryArtifacts
    : appliedBundleArtifacts;
  const status: TrainingReadinessStatus =
    readyArtifacts.length > 0
      ? "ready"
      : modelArtifacts.length > 0
        ? "partial"
        : "missing";
  return {
    id: "model_tracking",
    label: "Model tracking",
    status,
    artifactCount:
      status === "ready" ? readyArtifacts.length : modelArtifacts.length,
    artifactPaths:
      status === "ready"
        ? readyArtifacts.map((artifact) => artifact.path)
        : modelArtifacts.map((artifact) => artifact.path),
    note:
      status === "ready"
        ? hasAllEliza1Variants
          ? "Base and trained Eliza-1 model registry entries are represented for every tier."
          : "An applied staged bundle is represented."
        : status === "partial"
          ? "Model artifacts are present, but they do not cover base and trained Eliza-1 entries for every tier."
          : "No model or staged bundle artifact was found.",
    recommendedAction:
      status === "ready"
        ? null
        : {
            label:
              "Stage or register concrete base/trained Eliza-1 model artifacts",
            capability: "terminal-training-stage-eliza1-bundle",
            params: { tier: "2b", apply: true },
          },
  };
}

function coverageCheck(
  fallback: TrainingReadinessCheck,
  status: TrainingReadinessStatus | null,
  input: {
    artifactCount: number;
    readyNote: string;
    partialNote: string;
  },
): TrainingReadinessCheck {
  if (!status) return fallback;
  return {
    ...fallback,
    status,
    artifactCount: input.artifactCount,
    note: status === "ready" ? input.readyNote : input.partialNote,
    recommendedAction: status === "ready" ? null : fallback.recommendedAction,
  };
}

function coverageTierStatus(
  coverage: TrainingAnalysisCoverageSummary | undefined,
  tiers: readonly string[],
  predicate: (
    tier: TrainingAnalysisCoverageSummary["benchmarks"]["tierCoverage"][number],
  ) => boolean,
): TrainingReadinessStatus | null {
  const tierCoverage = coverage?.benchmarks.tierCoverage ?? [];
  if (tierCoverage.length === 0) return null;
  const requested = tiers.map((tier) => {
    const normalized = normalizeTier(tier);
    return normalized ?? tier;
  });
  const matched = requested
    .map((tier) => tierCoverage.find((entry) => entry.tier === tier))
    .filter(
      (
        entry,
      ): entry is TrainingAnalysisCoverageSummary["benchmarks"]["tierCoverage"][number] =>
        entry !== undefined,
    );
  if (matched.length === requested.length && matched.every(predicate)) {
    return "ready";
  }
  if ((coverage?.benchmarks.matrices ?? 0) > 0) return "partial";
  return null;
}

function readableSourceCoverageStatus(
  coverage: TrainingAnalysisCoverageSummary,
): TrainingReadinessStatus | null {
  const sourceKeys = [
    "huggingFace",
    "feed",
    "natural",
    "scenarios",
    "tests",
    "trainingJsonl",
  ] as const;
  const presentSources = sourceKeys.filter(
    (key) => (coverage.dataSources[key] ?? 0) > 0,
  );
  if (presentSources.length === 0) return null;
  if (presentSources.every((key) => (coverage.readableSamples[key] ?? 0) > 0)) {
    return "ready";
  }
  return "partial";
}

function applyCoverageReadiness(
  checks: TrainingReadinessCheck[],
  coverage: TrainingAnalysisCoverageSummary | undefined,
): TrainingReadinessCheck[] {
  if (!coverage) return checks;
  return checks.map((item) => {
    if (item.id === "readable_source_samples") {
      return coverageCheck(item, readableSourceCoverageStatus(coverage), {
        artifactCount: coverage.readableSamples.total,
        readyNote:
          "Analysis coverage includes readable trajectory samples for every collected source category.",
        partialNote:
          "Analysis coverage found collected trajectory sources that do not all expose readable samples yet.",
      });
    }
    if (item.id === "eval_comparison") {
      const harnessComparisons =
        coverage.benchmarks.scoredComparisons > 0 ||
        coverage.benchmarks.tierCoverage.some((tier) => tier.hasImprovement);
      return coverageCheck(
        item,
        coverage.evals.scoredComparisons > 0 || harnessComparisons
          ? "ready"
          : coverage.evals.comparisons > 0 ||
              coverage.benchmarks.comparisons > 0 ||
              coverage.benchmarks.matrices > 0
            ? "partial"
            : null,
        {
          artifactCount:
            coverage.evals.scoredComparisons > 0 ||
            coverage.evals.comparisons > 0
              ? coverage.evals.comparisons
              : coverage.benchmarks.comparisons || coverage.benchmarks.matrices,
          readyNote:
            "Analysis coverage includes a scored base-vs-trained Eliza harness or eval comparison.",
          partialNote:
            "Analysis coverage found comparison artifacts without complete scored Eliza harness improvement metrics.",
        },
      );
    }
    if (item.id === "benchmark_matrix") {
      return coverageCheck(
        item,
        coverage.benchmarks.scoredComparisons > 0
          ? "ready"
          : coverage.benchmarks.matrices > 0
            ? "partial"
            : null,
        {
          artifactCount: coverage.benchmarks.matrices,
          readyNote:
            "Analysis coverage includes benchmark matrix scored comparisons.",
          partialNote:
            "Analysis coverage found benchmark matrices without scored comparisons.",
        },
      );
    }
    if (item.id === "benchmark_case_provenance") {
      return coverageCheck(
        item,
        coverage.benchmarks.caseSamples > 0
          ? "ready"
          : coverage.benchmarks.matrices > 0
            ? "partial"
            : null,
        {
          artifactCount: coverage.benchmarks.caseSamples,
          readyNote:
            "Analysis coverage includes benchmark case prompts, outputs, and trajectory paths.",
          partialNote:
            "Analysis coverage found benchmark matrices without readable case provenance.",
        },
      );
    }
    if (item.id === "smallest_model_benchmark") {
      return coverageCheck(
        item,
        coverageTierStatus(
          coverage,
          ["2b"],
          (tier) => tier.hasBase && tier.hasTrained,
        ),
        {
          artifactCount: coverage.benchmarks.matrices,
          readyNote:
            "Analysis coverage includes smallest-tier base/trained benchmark comparison.",
          partialNote:
            "Analysis coverage found benchmark matrices without complete smallest-tier base/trained comparison.",
        },
      );
    }
    if (item.id === "all_eliza1_tiers_benchmark") {
      return coverageCheck(
        item,
        coverageTierStatus(
          coverage,
          ELIZA_ONE_BENCHMARK_TIERS,
          (tier) => tier.hasBase && tier.hasTrained,
        ),
        {
          artifactCount: coverage.benchmarks.matrices,
          readyNote:
            "Analysis coverage includes base/trained benchmark comparisons for every Eliza-1 tier.",
          partialNote:
            "Analysis coverage found benchmark matrices without complete all-tier base/trained comparisons.",
        },
      );
    }
    if (item.id === "cerebras_reference") {
      return coverageCheck(
        item,
        coverageTierStatus(coverage, ["2b"], (tier) => tier.hasReference) ===
          "ready" ||
          coverage.benchmarks.tierCoverage.some((tier) => tier.hasReference)
          ? "ready"
          : coverage.benchmarks.matrices > 0
            ? "partial"
            : null,
        {
          artifactCount: coverage.benchmarks.matrices,
          readyNote: "Analysis coverage includes a Cerebras reference score.",
          partialNote:
            "Analysis coverage found benchmark matrices without a Cerebras reference score.",
        },
      );
    }
    if (item.id === "base_trained_improvement") {
      return coverageCheck(
        item,
        coverage.benchmarks.tierCoverage.some(
          (tier) => tier.hasBase && tier.hasTrained && tier.hasImprovement,
        )
          ? "ready"
          : coverage.benchmarks.matrices > 0
            ? "partial"
            : null,
        {
          artifactCount: coverage.benchmarks.scoredComparisons,
          readyNote:
            "Analysis coverage includes base/trained benchmark improvement.",
          partialNote:
            "Analysis coverage found benchmark matrices without base/trained improvement.",
        },
      );
    }
    if (item.id === "all_eliza1_tier_improvements") {
      return coverageCheck(
        item,
        coverageTierStatus(
          coverage,
          ELIZA_ONE_BENCHMARK_TIERS,
          (tier) => tier.hasBase && tier.hasTrained && tier.hasImprovement,
        ),
        {
          artifactCount: coverage.benchmarks.scoredComparisons,
          readyNote:
            "Analysis coverage includes percentage improvement for every Eliza-1 tier.",
          partialNote:
            "Analysis coverage found benchmark matrices without all-tier percentage improvement.",
        },
      );
    }
    return item;
  });
}

function check(
  artifacts: readonly TrainingAnalysisArtifact[],
  input: {
    id: string;
    label: string;
    ready: ArtifactPredicate;
    partial?: ArtifactPredicate;
    readyNote: string;
    partialNote?: string;
    missingNote: string;
    recommendedAction?: TrainingReadinessAction;
  },
): TrainingReadinessCheck {
  const readyArtifacts = artifacts.filter(input.ready);
  const partialArtifacts =
    readyArtifacts.length === 0 && input.partial
      ? artifacts.filter(input.partial)
      : [];
  const matched = readyArtifacts.length > 0 ? readyArtifacts : partialArtifacts;
  const status: TrainingReadinessStatus =
    readyArtifacts.length > 0
      ? "ready"
      : partialArtifacts.length > 0
        ? "partial"
        : "missing";
  return {
    id: input.id,
    label: input.label,
    status,
    artifactCount: matched.length,
    artifactPaths: matched.map((artifact) => artifact.path),
    note:
      status === "ready"
        ? input.readyNote
        : status === "partial"
          ? (input.partialNote ?? input.readyNote)
          : input.missingNote,
    recommendedAction:
      status === "ready" ? null : (input.recommendedAction ?? null),
  };
}

export function buildTrainingReadinessReportPayload(
  analysis: TrainingAnalysisIndex,
  options: {
    generatedAt?: string;
    outputDir?: string;
    reportPath?: string;
  } = {},
): TrainingReadinessReport {
  const artifacts = analysis.manifest.artifacts;
  const coverage = analysis.manifest.coverage;
  const checks = applyCoverageReadiness(
    [
      check(artifacts, {
        id: "huggingface_training_data",
        label: "Hugging Face training data",
        ready: (artifact) =>
          artifact.kind === "trajectory_dataset" &&
          (schemaOf(artifact) === "eliza_huggingface_dataset_ingest" ||
            sourceKindOf(artifact) === "huggingface_dataset") &&
          (numberSummary(artifact, "downloadedFiles") ?? 0) > 0 &&
          (numberSummary(artifact, "jsonlRows") ?? 0) > 0,
        partial: (artifact) =>
          artifact.kind === "trajectory_dataset" &&
          (schemaOf(artifact) === "eliza_huggingface_dataset_ingest" ||
            sourceKindOf(artifact) === "huggingface_dataset"),
        readyNote: "Downloaded Hugging Face training rows are represented.",
        partialNote:
          "A Hugging Face ingest artifact is present, but it has no downloaded JSONL rows.",
        missingNote:
          "No Hugging Face training dataset ingest manifest was found.",
        recommendedAction: {
          label: "Download Hugging Face training files",
          capability: "terminal-training-ingest-hf-dataset",
          params: { dryRun: false },
        },
      }),
      check(artifacts, {
        id: "feed_generation",
        label: "Feed generated trajectories",
        ready: (artifact) =>
          artifact.kind === "trajectory_dataset" &&
          (schemaOf(artifact) === "feed_training_trajectory_export" ||
            schemaOf(artifact) === "feed_parallel_generation") &&
          !isDryRunArtifact(artifact) &&
          hasPositiveSummary(artifact, [
            "rows",
            "trajectories",
            "parsedTrajectories",
            "agentsCreated",
          ]),
        partial: (artifact) =>
          artifact.kind === "trajectory_dataset" &&
          (schemaOf(artifact) === "feed_training_trajectory_export" ||
            schemaOf(artifact) === "feed_parallel_generation"),
        readyNote:
          "Feed generation artifacts include generated trajectory data.",
        partialNote:
          "A feed generation artifact is present, but it is a dry run or has no generated trajectory rows.",
        missingNote: "No feed trajectory generation artifact was found.",
        recommendedAction: {
          label: "Generate feed training trajectories",
          capability: "terminal-training-feed-generate",
          params: {
            dryRun: false,
            archetypes: "trader",
            numAgents: 1,
            ticks: 1,
            parallel: 1,
          },
        },
      }),
      check(artifacts, {
        id: "natural_trajectories",
        label: "Natural app trajectories",
        ready: (artifact) =>
          artifact.kind === "trajectory_bundle" &&
          sourceLabelOf(artifact) ===
            "training_collection_natural_trajectories" &&
          hasPositiveSummary(artifact, [
            "sanitizedTrajectoryCount",
            "taskExamples",
            "llmCalls",
          ]),
        partial: (artifact) =>
          artifact.kind === "trajectory_bundle" &&
          sourceLabelOf(artifact) ===
            "training_collection_natural_trajectories",
        readyNote:
          "Natural app/runtime trajectory bundles include trajectory rows.",
        partialNote:
          "A natural app trajectory bundle is present, but it has no counted trajectory rows.",
        missingNote: "No natural app/runtime trajectory bundle was found.",
        recommendedAction: {
          label: "Collect natural app/runtime trajectories",
          capability: "terminal-training-run-collection",
          params: {
            includeNaturalTrajectories: true,
          },
        },
      }),
      check(artifacts, {
        id: "test_trajectories",
        label: "Test trajectories",
        ready: (artifact) =>
          artifact.kind === "trajectory_dataset" &&
          sourceKindOf(artifact) === "app_core_test_trajectory" &&
          hasPositiveSummary(artifact, ["actions", "llmCalls"]),
        partial: (artifact) =>
          artifact.kind === "trajectory_dataset" &&
          sourceKindOf(artifact) === "app_core_test_trajectory",
        readyNote: "Test trajectory artifacts include action or LLM rows.",
        partialNote:
          "A test trajectory artifact is present, but it has no counted actions or LLM rows.",
        missingNote: "No test trajectory artifact was found.",
        recommendedAction: {
          label: "Collect app-core test trajectories",
          capability: "terminal-training-run-collection",
          params: {
            includeTestTrajectories: true,
          },
        },
      }),
      check(artifacts, {
        id: "scenario_trajectories",
        label: "Scenario trajectories",
        ready: (artifact) =>
          (artifact.kind === "scenario_run" &&
            hasPositiveSummary(artifact, ["totalCount", "nativeRows"])) ||
          (artifact.kind === "trajectory_dataset" &&
            schemaOf(artifact) === "eliza_scenario_native_export" &&
            hasPositiveSummary(artifact, ["rows", "parsedTrajectories"])),
        partial: (artifact) =>
          artifact.kind === "scenario_run" ||
          (artifact.kind === "trajectory_dataset" &&
            schemaOf(artifact) === "eliza_scenario_native_export"),
        readyNote:
          "Scenario run or native scenario export artifacts include scenario rows.",
        partialNote:
          "A scenario artifact is present, but it has no counted scenario or native trajectory rows.",
        missingNote: "No scenario run or native scenario export was found.",
        recommendedAction: {
          label: "Run scenarios with native trajectory export",
          capability: "terminal-training-run-scenarios",
          params: {
            dryRun: false,
            exportNative: true,
            useDeterministicProxy: true,
          },
        },
      }),
      check(artifacts, {
        id: "readable_source_samples",
        label: "Readable trajectory samples",
        ready: (artifact) =>
          (artifact.kind === "trajectory_bundle" ||
            artifact.kind === "trajectory_dataset" ||
            artifact.kind === "scenario_run") &&
          hasReadableSamplePreview(artifact),
        partial: (artifact) =>
          artifact.kind === "trajectory_bundle" ||
          artifact.kind === "trajectory_dataset" ||
          artifact.kind === "scenario_run",
        readyNote:
          "Trajectory artifacts include readable input/output or trajectory sample previews for the HTML viewer.",
        partialNote:
          "Trajectory artifacts are present, but none expose readable sample previews yet.",
        missingNote:
          "No trajectory artifact with readable HTML-viewer samples was found.",
        recommendedAction: {
          label: "Build the training analysis viewer from collected artifacts",
          capability: "terminal-training-build-analysis-index",
          params: {},
        },
      }),
      check(artifacts, {
        id: "eval_comparison",
        label: "Base vs trained Eliza harness eval comparison",
        ready: (artifact) =>
          (artifact.kind === "eval" &&
            schemaOf(artifact) === "eliza_eval_comparison_artifact" &&
            hasScoredEvalImprovement(artifact)) ||
          (artifact.kind === "benchmark_matrix" &&
            hasImprovementComparison(artifact)),
        partial: (artifact) =>
          (artifact.kind === "eval" &&
            schemaOf(artifact) === "eliza_eval_comparison_artifact") ||
          artifact.kind === "benchmark_matrix",
        readyNote:
          "A scored base-vs-trained Eliza harness or eval comparison with percentage improvement is present.",
        partialNote:
          "A comparison artifact is present, but it does not include base score, trained score, and percentage improvement from the Eliza harness.",
        missingNote:
          "No base-vs-trained Eliza harness eval comparison artifact was found.",
        recommendedAction: actionBenchmarkPairCollectionAction(
          "Run scored base-vs-trained Eliza harness eval comparison",
          ["2b"],
        ),
      }),
      check(artifacts, {
        id: "agentic_benchmarks",
        label: "Eliza harness benchmarks",
        ready: (artifact) =>
          artifact.kind === "eval" &&
          isElizaHarnessActionBenchmark(artifact) &&
          (typeof artifact.summary.accuracy === "number" ||
            typeof artifact.summary.score === "number" ||
            typeof artifact.summary.passRate === "number") &&
          ((numberSummary(artifact, "total") ?? 1) > 0 ||
            (numberSummary(artifact, "results") ?? 1) > 0),
        partial: (artifact) =>
          artifact.kind === "eval" && isElizaHarnessActionBenchmark(artifact),
        readyNote: "Agentic benchmark artifacts include scored results.",
        partialNote:
          "An agentic benchmark artifact is present, but it has no score.",
        missingNote: "No Eliza harness benchmark artifact was found.",
        recommendedAction: {
          label: "Run Eliza action-selection benchmark",
          capability: "terminal-training-run-collection",
          params: {
            includeActionBenchmark: true,
            includeBenchmarkMatrix: true,
            actionBenchmark: {
              dryRun: false,
              useMocks: false,
              runsPerCase: 1,
              provider: "local-llama-cpp",
              benchmark: "eliza_harness_action_selection",
            },
            actionBenchmarkPair: {
              tier: "2b",
              base: { variant: "base" },
              trained: { variant: "trained" },
            },
          },
        },
      }),
      check(artifacts, {
        id: "benchmark_matrix",
        label: "Benchmark matrix",
        ready: (artifact) =>
          artifact.kind === "benchmark_matrix" &&
          hasPositiveSummary(artifact, ["rows", "comparisons"]) &&
          hasRealBenchmarkMatrixRows(artifact),
        partial: (artifact) => artifact.kind === "benchmark_matrix",
        readyNote: "Benchmark matrix artifact includes rows or comparisons.",
        partialNote:
          "A benchmark matrix artifact is present, but it has no rows or comparisons.",
        missingNote: "No benchmark matrix artifact was found.",
        recommendedAction: actionBenchmarkPairCollectionAction(
          "Generate benchmark matrix from Eliza harness artifacts",
          ["2b"],
        ),
      }),
      check(artifacts, {
        id: "benchmark_case_provenance",
        label: "Benchmark case provenance",
        ready: (artifact) =>
          artifact.kind === "benchmark_matrix" &&
          hasBenchmarkCaseProvenance(artifact),
        partial: (artifact) => artifact.kind === "benchmark_matrix",
        readyNote:
          "Benchmark matrix rows include Eliza harness case prompts, actions, and trajectory paths.",
        partialNote:
          "A benchmark matrix exists, but its rows do not include readable case provenance.",
        missingNote:
          "No benchmark matrix with Eliza harness case provenance was found.",
        recommendedAction: actionBenchmarkPairCollectionAction(
          "Run Eliza harness benchmark with trajectory capture",
          ["2b"],
        ),
      }),
      check(artifacts, {
        id: "smallest_model_benchmark",
        label: "Smallest Eliza-1 benchmark coverage",
        ready: (artifact) =>
          artifact.kind === "benchmark_matrix" &&
          hasSmallestTierComparison(artifact),
        partial: (artifact) => artifact.kind === "benchmark_matrix",
        readyNote:
          "Benchmark matrix includes scored coverage for the smallest Eliza-1 tier.",
        partialNote:
          "A benchmark matrix exists, but it does not prove scored smallest-tier coverage.",
        missingNote:
          "No benchmark matrix exists for the smallest Eliza-1 tier.",
        recommendedAction: actionBenchmarkPairCollectionAction(
          "Run smallest-tier base/trained Eliza harness benchmark",
          ["2b"],
        ),
      }),
      check(artifacts, {
        id: "all_eliza1_tiers_benchmark",
        label: "All Eliza-1 tier benchmark coverage",
        ready: (artifact) =>
          artifact.kind === "benchmark_matrix" &&
          hasAllEliza1BenchmarkTierComparisons(artifact),
        partial: (artifact) => artifact.kind === "benchmark_matrix",
        readyNote:
          "Benchmark matrix includes scored coverage for 2B, 4B, 9B, and 27B tiers.",
        partialNote:
          "A benchmark matrix exists, but it does not prove scored coverage for every Eliza-1 tier.",
        missingNote:
          "No benchmark matrix exists for all requested Eliza-1 tiers.",
        recommendedAction: actionBenchmarkPairCollectionAction(
          "Run all-tier base/trained Eliza harness benchmarks",
          ELIZA_ONE_BENCHMARK_TIERS,
        ),
      }),
      check(artifacts, {
        id: "cerebras_reference",
        label: "Cerebras reference benchmark",
        ready: (artifact) =>
          artifact.kind === "benchmark_matrix" &&
          hasCerebrasReferenceComparison(artifact),
        partial: (artifact) => artifact.kind === "benchmark_matrix",
        readyNote: "Benchmark matrix includes a Cerebras reference comparison.",
        partialNote:
          "A benchmark matrix exists, but it does not prove a Cerebras reference comparison.",
        missingNote: "No Cerebras reference benchmark artifact was found.",
        recommendedAction: {
          label: "Run benchmark against Cerebras GPT-120b",
          capability: "terminal-training-run-benchmark-vs-cerebras",
          params: {
            tiers: ELIZA_ONE_BENCHMARK_TIER_LIST,
            benchmark: "eliza_harness_action_selection",
            variants: "both",
            dryRun: false,
          },
        },
      }),
      check(artifacts, {
        id: "base_trained_improvement",
        label: "Base vs trained improvement metrics",
        ready: (artifact) =>
          artifact.kind === "benchmark_matrix" &&
          hasImprovementComparison(artifact),
        partial: (artifact) => artifact.kind === "benchmark_matrix",
        readyNote:
          "Benchmark matrix includes base/trained scores with percentage improvement.",
        partialNote:
          "A benchmark matrix exists, but it does not prove base/trained percentage improvement.",
        missingNote:
          "No benchmark matrix exists with base/trained percentage improvement.",
        recommendedAction: actionBenchmarkPairCollectionAction(
          "Run base/trained Eliza harness improvement comparison",
          ["2b"],
        ),
      }),
      check(artifacts, {
        id: "all_eliza1_tier_improvements",
        label: "All Eliza-1 tier improvement metrics",
        ready: (artifact) =>
          artifact.kind === "benchmark_matrix" &&
          hasAllEliza1TierImprovementComparisons(artifact),
        partial: (artifact) => artifact.kind === "benchmark_matrix",
        readyNote:
          "Benchmark matrix includes percentage improvement for 2B, 4B, 9B, and 27B tiers.",
        partialNote:
          "A benchmark matrix exists, but it does not prove percentage improvement for every Eliza-1 tier.",
        missingNote:
          "No benchmark matrix exists with percentage improvement for every requested Eliza-1 tier.",
        recommendedAction: actionBenchmarkPairCollectionAction(
          "Run all-tier base/trained Eliza harness improvement comparison",
          ELIZA_ONE_BENCHMARK_TIERS,
        ),
      }),
      buildModelTrackingCheck(artifacts, coverage),
      check(artifacts, {
        id: "collection_manifest",
        label: "Collection manifest",
        ready: (artifact) => artifact.kind === "collection_run",
        readyNote: "A collection manifest ties the run together.",
        missingNote: "No training collection manifest was found.",
        recommendedAction: {
          label: "Run training collection",
          capability: "terminal-training-run-collection",
          params: {},
        },
      }),
    ],
    coverage,
  );
  const counts = {
    checks: checks.length,
    ready: checks.filter((item) => item.status === "ready").length,
    partial: checks.filter((item) => item.status === "partial").length,
    missing: checks.filter((item) => item.status === "missing").length,
    artifacts: artifacts.length,
  };
  const status: TrainingReadinessStatus =
    counts.missing === 0 && counts.partial === 0
      ? "ready"
      : counts.ready > 0 || counts.partial > 0
        ? "partial"
        : "missing";
  const outputDir = options.outputDir ?? analysis.outputDir;
  const reportPath =
    options.reportPath ?? join(outputDir, "training-readiness-report.json");
  return {
    schema: TRAINING_READINESS_REPORT_SCHEMA,
    schemaVersion: TRAINING_READINESS_REPORT_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    outputDir,
    reportPath,
    analysisManifestPath: analysis.manifestPath,
    analysisIndexHtmlPath: analysis.indexHtmlPath,
    status,
    counts,
    checks,
  };
}

export async function writeTrainingReadinessReport(
  analysis: TrainingAnalysisIndex,
  options: {
    outputDir?: string;
    reportPath?: string;
    generatedAt?: string;
  } = {},
): Promise<TrainingReadinessReportResult> {
  const report = buildTrainingReadinessReportPayload(analysis, options);
  await mkdir(report.outputDir, { recursive: true });
  await writeFile(
    report.reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return {
    outputDir: report.outputDir,
    reportPath: report.reportPath,
    report,
  };
}
