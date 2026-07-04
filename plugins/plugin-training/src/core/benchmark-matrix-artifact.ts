/**
 * Builds the benchmark-matrix artifact: aggregates per-tier Eliza-1 results
 * (2b/4b/9b/27b, base vs trained) into a single schema-tagged JSON artifact.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalElizaOneTierSort,
  normalizeElizaOneBenchmarkTier,
} from "./eliza1-benchmark-recipe.js";
import { EVAL_COMPARISON_ARTIFACT_SCHEMA } from "./eval-comparison-artifact.js";
import { trainingStateRoot } from "./training-config.js";

export const BENCHMARK_MATRIX_ARTIFACT_SCHEMA =
  "eliza_benchmark_matrix_artifact";
export const BENCHMARK_MATRIX_ARTIFACT_VERSION = 1;
export const ACTION_BENCHMARK_REPORT_SCHEMA =
  "eliza_action_selection_benchmark_report";
export const ACTION_SELECTION_BENCHMARK_ID = "eliza_harness_action_selection";
export const LOCAL_EVAL_COMPARISON_BENCHMARK_ID =
  "eliza_harness_local_eval_comparison";

export const ELIZA_ONE_MATRIX_TIERS = ["0b", "2b", "4b", "9b", "27b"] as const;

export type ElizaOneMatrixTier = (typeof ELIZA_ONE_MATRIX_TIERS)[number];
export type BenchmarkMatrixVariant = "reference" | "base" | "trained";

export interface BenchmarkMatrixRowInput {
  modelId: string;
  benchmark: string;
  score: number;
  variant: BenchmarkMatrixVariant;
  tier?: string;
  provider?: string;
  datasetVersion?: string;
  codeCommit?: string;
  ts?: number | string;
  metrics?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface BenchmarkMatrixInput {
  rows: BenchmarkMatrixRowInput[];
  outputDir?: string;
  generatedAt?: string;
  referenceModelId?: string;
  source?: Record<string, unknown>;
}

export interface BenchmarkMatrixArtifactSource {
  path: string;
  modelId?: string;
  benchmark?: string;
  variant?: BenchmarkMatrixVariant;
  tier?: string;
  provider?: string;
  datasetVersion?: string;
  codeCommit?: string;
  useMocks?: boolean;
}

export interface BenchmarkMatrixFromArtifactsInput {
  artifacts: BenchmarkMatrixArtifactSource[];
  outputDir?: string;
  generatedAt?: string;
  referenceModelId?: string;
  source?: Record<string, unknown>;
}

export interface BenchmarkMatrixCell {
  modelId: string;
  benchmark: string;
  score: number;
  variant: BenchmarkMatrixVariant;
  tier: string | null;
  provider: string | null;
  datasetVersion: string | null;
  codeCommit: string | null;
  ts: number | string | null;
  metrics: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface BenchmarkMatrixComparison {
  tier: string;
  benchmark: string;
  baseModelId: string | null;
  trainedModelId: string | null;
  referenceModelId: string | null;
  baseScore: number | null;
  trainedScore: number | null;
  referenceScore: number | null;
  improvementAbsolute: number | null;
  improvementPercent: number | null;
  trainedVsReferenceAbsolute: number | null;
  trainedVsReferencePercent: number | null;
  dryRun: boolean;
}

export interface BenchmarkMatrixArtifact {
  schema: typeof BENCHMARK_MATRIX_ARTIFACT_SCHEMA;
  version: typeof BENCHMARK_MATRIX_ARTIFACT_VERSION;
  generatedAt: string;
  source: Record<string, unknown>;
  referenceModelId: string | null;
  tiers: string[];
  benchmarks: string[];
  counts: {
    rows: number;
    comparisons: number;
    tiers: number;
    benchmarks: number;
  };
  rows: BenchmarkMatrixCell[];
  comparisons: BenchmarkMatrixComparison[];
}

export interface BenchmarkMatrixArtifactResult {
  outputDir: string;
  artifactPath: string;
  artifact: BenchmarkMatrixArtifact;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteScore(value: number): number {
  if (!Number.isFinite(value))
    throw new Error(`score must be finite; got ${value}`);
  return value;
}

function roundMetric(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(6));
}

function percentDelta(base: number | null, next: number | null): number | null {
  if (base === null || next === null || base === 0) return null;
  return ((next - base) / Math.abs(base)) * 100;
}

function isDryRunRow(row: BenchmarkMatrixCell | null | undefined): boolean {
  if (!row) return false;
  const rawSource = asRecord(row.raw.source);
  return (
    row.metrics.dryRun === true ||
    row.raw.dryRun === true ||
    rawSource?.dryRun === true
  );
}

function inferTier(modelId: string, explicit?: string): string | null {
  const tier = asString(explicit);
  if (tier) return normalizeElizaOneBenchmarkTier(tier) ?? tier;
  const normalized = modelId.toLowerCase();
  if (normalized.includes("27b")) return "27b";
  if (normalized.includes("9b")) return "9b";
  if (normalized.includes("4b")) return "4b";
  if (normalized.includes("2b")) return "2b";
  if (normalized.includes("0b")) return "0b";
  return null;
}

function normalizeRow(row: BenchmarkMatrixRowInput): BenchmarkMatrixCell {
  const explicitReferenceTier = asString(row.tier);
  return {
    modelId: row.modelId,
    benchmark: row.benchmark,
    score: finiteScore(row.score),
    variant: row.variant,
    tier:
      row.variant === "reference" && !explicitReferenceTier
        ? null
        : inferTier(row.modelId, row.tier),
    provider: asString(row.provider),
    datasetVersion: asString(row.datasetVersion),
    codeCommit: asString(row.codeCommit),
    ts: row.ts ?? null,
    metrics: row.metrics ?? {},
    raw: row.raw ?? {},
  };
}

function selectReferenceModelId(
  rows: readonly BenchmarkMatrixCell[],
  explicit?: string,
): string | null {
  if (explicit) return explicit;
  return (
    rows.find((row) => row.variant === "reference")?.modelId ??
    rows.find((row) => row.provider === "cerebras")?.modelId ??
    null
  );
}

function scoreFor(
  rows: readonly BenchmarkMatrixCell[],
  benchmark: string,
  variant: BenchmarkMatrixVariant,
  tier?: string,
): BenchmarkMatrixCell | null {
  if (variant === "reference") {
    return (
      rows.find(
        (row) =>
          row.benchmark === benchmark &&
          row.variant === "reference" &&
          row.tier === tier,
      ) ??
      rows.find(
        (row) =>
          row.benchmark === benchmark &&
          row.variant === "reference" &&
          row.tier === null,
      ) ??
      null
    );
  }
  return (
    rows.find(
      (row) =>
        row.benchmark === benchmark &&
        row.variant === variant &&
        row.tier === tier,
    ) ?? null
  );
}

function buildComparisons(
  rows: readonly BenchmarkMatrixCell[],
  referenceModelId: string | null,
): BenchmarkMatrixComparison[] {
  const tiers = Array.from(
    new Set(
      rows
        .map((row) => row.tier)
        .filter((tier): tier is string => tier !== null),
    ),
  ).sort(canonicalElizaOneTierSort);
  const benchmarks = Array.from(
    new Set(rows.map((row) => row.benchmark)),
  ).sort();
  const comparisons: BenchmarkMatrixComparison[] = [];
  for (const tier of tiers) {
    for (const benchmark of benchmarks) {
      const base = scoreFor(rows, benchmark, "base", tier);
      const trained = scoreFor(rows, benchmark, "trained", tier);
      const reference = scoreFor(rows, benchmark, "reference", tier);
      if (!base && !trained && !reference) continue;
      const dryRun =
        isDryRunRow(base) || isDryRunRow(trained) || isDryRunRow(reference);
      comparisons.push({
        tier,
        benchmark,
        baseModelId: base?.modelId ?? null,
        trainedModelId: trained?.modelId ?? null,
        referenceModelId: reference?.modelId ?? referenceModelId,
        baseScore: base?.score ?? null,
        trainedScore: trained?.score ?? null,
        referenceScore: reference?.score ?? null,
        improvementAbsolute: roundMetric(
          base && trained ? trained.score - base.score : null,
        ),
        improvementPercent: roundMetric(
          percentDelta(base?.score ?? null, trained?.score ?? null),
        ),
        trainedVsReferenceAbsolute: roundMetric(
          trained && reference ? trained.score - reference.score : null,
        ),
        trainedVsReferencePercent: roundMetric(
          percentDelta(reference?.score ?? null, trained?.score ?? null),
        ),
        dryRun,
      });
    }
  }
  return comparisons;
}

function safeTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function rowFromActionBenchmarkArtifact(
  payload: Record<string, unknown>,
  source: BenchmarkMatrixArtifactSource,
): BenchmarkMatrixRowInput[] {
  const reportSource = asRecord(payload.source) ?? {};
  const embeddedVariant = reportSource.variant;
  const modelId = source.modelId ?? asString(reportSource.modelId) ?? undefined;
  const variant =
    source.variant ??
    (embeddedVariant === "reference" ||
    embeddedVariant === "base" ||
    embeddedVariant === "trained"
      ? embeddedVariant
      : undefined);
  if (!modelId || !variant) {
    throw new Error(
      `Action benchmark artifact ${source.path} requires modelId and variant`,
    );
  }
  const summary = asRecord(payload.summary) ?? {};
  const dryRun = payload.dryRun === true || reportSource.dryRun === true;
  const useMocks =
    source.useMocks === true ||
    reportSource.useMocks === true ||
    payload.useMocks === true;
  const score = asNumber(summary.accuracy) ?? (dryRun ? 0 : null);
  if (score === null) {
    throw new Error(
      `Action benchmark artifact ${source.path} missing accuracy`,
    );
  }
  const caseSamples = Array.isArray(payload.results)
    ? payload.results
        .map(asRecord)
        .filter((result): result is Record<string, unknown> => result !== null)
        .slice(0, 8)
        .map((result) => ({
          caseId: asString(result.caseId),
          prompt:
            asString(result.prompt) ??
            asString(result.input) ??
            asString(result.userPrompt),
          expectedAction: asString(result.expectedAction),
          actualAction: asString(result.actualAction),
          pass: result.pass === true,
          response:
            asString(result.response) ??
            asString(result.output) ??
            asString(result.finalResponse) ??
            asString(result.failureReason),
          latencyMs: asNumber(result.latencyMs),
          trajectoryPath: asString(result.trajectoryPath),
        }))
    : [];
  return [
    {
      modelId,
      variant,
      benchmark:
        source.benchmark ??
        asString(reportSource.benchmark) ??
        ACTION_SELECTION_BENCHMARK_ID,
      score,
      tier: source.tier ?? asString(reportSource.tier) ?? undefined,
      provider: source.provider ?? asString(reportSource.provider) ?? undefined,
      datasetVersion:
        source.datasetVersion ??
        asString(reportSource.datasetVersion) ??
        undefined,
      codeCommit:
        source.codeCommit ?? asString(reportSource.codeCommit) ?? undefined,
      ts: asString(payload.generatedAt) ?? undefined,
      metrics: {
        plannerAccuracy: summary.plannerAccuracy,
        executionAccuracy: summary.executionAccuracy,
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        latency: summary.latency,
        failureModes: payload.failureModes,
        dryRun,
        useMocks,
      },
      raw: {
        artifactPath: source.path,
        schema: payload.schema,
        source: payload.source,
        caseSamples,
        dryRun,
        useMocks,
      },
    },
  ];
}

function rowsFromEvalComparisonArtifact(
  payload: Record<string, unknown>,
  source: BenchmarkMatrixArtifactSource,
): BenchmarkMatrixRowInput[] {
  const models = asRecord(payload.models) ?? {};
  const metrics = asRecord(payload.metrics) ?? {};
  const benchmark = source.benchmark ?? LOCAL_EVAL_COMPARISON_BENCHMARK_ID;
  const baseModelId =
    source.variant === "base" ? source.modelId : asString(models.base);
  const trainedModelId =
    source.variant === "trained" ? source.modelId : asString(models.trained);
  const rows: BenchmarkMatrixRowInput[] = [];
  const baseScore = asNumber(metrics.baseScore);
  if (baseModelId && baseScore !== null) {
    rows.push({
      modelId: baseModelId,
      variant: "base",
      benchmark,
      score: baseScore,
      tier: source.tier,
      provider: source.provider,
      datasetVersion: source.datasetVersion,
      codeCommit: source.codeCommit,
      ts: asString(payload.generatedAt) ?? undefined,
      metrics: {
        latencyMs: metrics.baseLatencyMs,
        promptCount: metrics.promptCount,
      },
      raw: {
        artifactPath: source.path,
        schema: payload.schema,
      },
    });
  }
  const trainedScore = asNumber(metrics.trainedScore);
  if (trainedModelId && trainedScore !== null) {
    rows.push({
      modelId: trainedModelId,
      variant: "trained",
      benchmark,
      score: trainedScore,
      tier: source.tier,
      provider: source.provider,
      datasetVersion: source.datasetVersion,
      codeCommit: source.codeCommit,
      ts: asString(payload.generatedAt) ?? undefined,
      metrics: {
        latencyMs: metrics.trainedLatencyMs,
        promptCount: metrics.promptCount,
        improvementAbsolute: metrics.improvementAbsolute,
        improvementPercent: metrics.improvementPercent,
      },
      raw: {
        artifactPath: source.path,
        schema: payload.schema,
      },
    });
  }
  return rows;
}

function rowsFromBenchmarkMatrixArtifact(
  payload: Record<string, unknown>,
  source: BenchmarkMatrixArtifactSource,
): BenchmarkMatrixRowInput[] {
  const rows = Array.isArray(payload.rows)
    ? payload.rows
        .map(asRecord)
        .filter((row): row is Record<string, unknown> => row !== null)
    : [];
  return rows.map((row) => {
    const modelId = asString(row.modelId);
    const benchmark = asString(row.benchmark);
    const variant = row.variant;
    const score = asNumber(row.score);
    if (
      !modelId ||
      !benchmark ||
      score === null ||
      (variant !== "reference" && variant !== "base" && variant !== "trained")
    ) {
      throw new Error(
        `Benchmark matrix artifact ${source.path} has an invalid row`,
      );
    }
    return {
      modelId,
      benchmark: source.benchmark ?? benchmark,
      score,
      variant,
      tier: source.tier ?? asString(row.tier) ?? undefined,
      provider: source.provider ?? asString(row.provider) ?? undefined,
      datasetVersion:
        source.datasetVersion ?? asString(row.datasetVersion) ?? undefined,
      codeCommit: source.codeCommit ?? asString(row.codeCommit) ?? undefined,
      ts: row.ts as number | string | undefined,
      metrics: asRecord(row.metrics) ?? {},
      raw: {
        ...(asRecord(row.raw) ?? {}),
        artifactPath: source.path,
        schema: payload.schema,
      },
    };
  });
}

export function buildBenchmarkMatrixRowsFromArtifactPayload(
  payload: Record<string, unknown>,
  source: BenchmarkMatrixArtifactSource,
): BenchmarkMatrixRowInput[] {
  if (payload.schema === ACTION_BENCHMARK_REPORT_SCHEMA) {
    return rowFromActionBenchmarkArtifact(payload, source);
  }
  if (payload.schema === EVAL_COMPARISON_ARTIFACT_SCHEMA) {
    return rowsFromEvalComparisonArtifact(payload, source);
  }
  if (payload.schema === BENCHMARK_MATRIX_ARTIFACT_SCHEMA) {
    return rowsFromBenchmarkMatrixArtifact(payload, source);
  }
  throw new Error(`Unsupported benchmark artifact schema in ${source.path}`);
}

export async function buildBenchmarkMatrixRowsFromArtifacts(
  artifacts: BenchmarkMatrixArtifactSource[],
): Promise<BenchmarkMatrixRowInput[]> {
  const rows: BenchmarkMatrixRowInput[] = [];
  for (const source of artifacts) {
    const payload = asRecord(JSON.parse(await readFile(source.path, "utf-8")));
    if (!payload)
      throw new Error(`Artifact ${source.path} must be a JSON object`);
    rows.push(...buildBenchmarkMatrixRowsFromArtifactPayload(payload, source));
  }
  return rows;
}

export function buildBenchmarkMatrixArtifactPayload(
  input: BenchmarkMatrixInput,
): BenchmarkMatrixArtifact {
  const rows = input.rows.map(normalizeRow);
  const referenceModelId = selectReferenceModelId(rows, input.referenceModelId);
  const tiers = Array.from(
    new Set(
      rows.map((row) => row.tier).filter((tier): tier is string => !!tier),
    ),
  ).sort(canonicalElizaOneTierSort);
  const benchmarks = Array.from(
    new Set(rows.map((row) => row.benchmark)),
  ).sort();
  const comparisons = buildComparisons(rows, referenceModelId);
  return {
    schema: BENCHMARK_MATRIX_ARTIFACT_SCHEMA,
    version: BENCHMARK_MATRIX_ARTIFACT_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    source: input.source ?? { kind: "training_benchmark_matrix" },
    referenceModelId,
    tiers,
    benchmarks,
    counts: {
      rows: rows.length,
      comparisons: comparisons.length,
      tiers: tiers.length,
      benchmarks: benchmarks.length,
    },
    rows,
    comparisons,
  };
}

export async function writeBenchmarkMatrixArtifact(
  input: BenchmarkMatrixInput,
): Promise<BenchmarkMatrixArtifactResult> {
  const artifact = buildBenchmarkMatrixArtifactPayload(input);
  const outputDir =
    input.outputDir ??
    join(
      trainingStateRoot(),
      "benchmarks",
      safeTimestamp(artifact.generatedAt),
    );
  await mkdir(outputDir, { recursive: true });
  const artifactPath = join(outputDir, "benchmark-matrix.json");
  await writeFile(
    artifactPath,
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf-8",
  );
  return { outputDir, artifactPath, artifact };
}

export async function writeBenchmarkMatrixArtifactFromArtifacts(
  input: BenchmarkMatrixFromArtifactsInput,
): Promise<BenchmarkMatrixArtifactResult> {
  const rows = await buildBenchmarkMatrixRowsFromArtifacts(input.artifacts);
  return writeBenchmarkMatrixArtifact({
    rows,
    outputDir: input.outputDir,
    generatedAt: input.generatedAt,
    referenceModelId: input.referenceModelId,
    source: input.source ?? {
      kind: "training_benchmark_matrix_from_artifacts",
      artifacts: input.artifacts.map((artifact) => artifact.path),
    },
  });
}
