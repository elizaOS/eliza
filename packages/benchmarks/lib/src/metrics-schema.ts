/**
 * Canonical metrics schema for the LifeOpsBench benchmark + prompt-optimization
 * pipeline.
 *
 * Single source of truth for `report.json` and `delta.json` artifacts emitted
 * by the three benchmark harnesses (hermes / openclaw / eliza). A Python
 * mirror lives at `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/metrics_schema.py`
 * and must stay field-for-field equivalent.
 *
 * Design rules (per AGENTS.md):
 *   - DTO fields required by default. Optional only when genuinely nullable.
 *   - `cacheSupported` is a hard boolean — not nullable, never inferred from
 *     missing data. Providers that do not support prompt caching set it false
 *     explicitly. Providers that do (Anthropic, OpenAI w/ cache key, Cerebras
 *     `gpt-oss-120b` default-on) set it true even when a particular call had
 *     no cache hit.
 *   - Cache hit / read / creation counts are `.nullable()` rather than
 *     defaulted, so "we don't know" stays distinguishable from "zero". No
 *     `?? 0` rescues anywhere downstream.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums / shared atoms
// ---------------------------------------------------------------------------

export const HARNESSES = ["hermes", "openclaw", "eliza"] as const;
export const HarnessSchema = z.enum(HARNESSES);
export type Harness = z.infer<typeof HarnessSchema>;

export const MODEL_TIERS = ["small", "mid", "large", "frontier"] as const;
export const ModelTierSchema = z.enum(MODEL_TIERS);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const STAGE_KINDS = [
  "plannerTurn",
  "toolCall",
  "toolSearch",
  "evaluation",
  "subPlanner",
  "compaction",
  "factsAndRelationships",
] as const;
export const StageKindSchema = z.enum(STAGE_KINDS);
export type StageKind = z.infer<typeof StageKindSchema>;

// ---------------------------------------------------------------------------
// TurnMetrics — one assistant turn within a scenario run
// ---------------------------------------------------------------------------

export const ToolCallMetricsSchema = z.object({
  name: z.string(),
  success: z.boolean(),
  durationMs: z.number(),
  error: z.string().optional(),
});
export type ToolCallMetrics = z.infer<typeof ToolCallMetricsSchema>;

export const TurnMetricsSchema = z.object({
  turnIdx: z.number().int().nonnegative(),
  startedAt: z.number(),
  endedAt: z.number(),
  latencyMs: z.number(),
  provider: z.string(),
  modelName: z.string(),
  modelTier: ModelTierSchema.optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative().nullable(),
  cacheCreationInputTokens: z.number().int().nonnegative().nullable(),
  cacheHitPct: z.number().min(0).max(1).nullable(),
  cacheSupported: z.boolean(),
  costUsd: z.number().nonnegative(),
  toolCalls: z.array(ToolCallMetricsSchema),
  toolSearchTopK: z.number().int().optional(),
  promptCacheKey: z.string().optional(),
  prefixHash: z.string().optional(),
});
export type TurnMetrics = z.infer<typeof TurnMetricsSchema>;

// ---------------------------------------------------------------------------
// StageMetrics — per-recorded-stage rollup
//
// Mirrors `RecordedStage` from `packages/core/src/runtime/trajectory-recorder.ts`
// but optimizer-focused: only the fields the optimizer and the aggregator read.
// ---------------------------------------------------------------------------

export const StageMetricsSchema = z.object({
  stageId: z.string(),
  kind: StageKindSchema,
  iteration: z.number().int().optional(),
  startedAt: z.number(),
  endedAt: z.number(),
  latencyMs: z.number(),
  provider: z.string().optional(),
  modelName: z.string().optional(),
  modelTier: ModelTierSchema.optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadInputTokens: z.number().int().nonnegative().nullable(),
  cacheCreationInputTokens: z.number().int().nonnegative().nullable(),
  cacheHitPct: z.number().min(0).max(1).nullable(),
  cacheSupported: z.boolean(),
  costUsd: z.number().nonnegative().optional(),
  toolName: z.string().optional(),
  toolSuccess: z.boolean().optional(),
  toolError: z.string().optional(),
  prefixHash: z.string().optional(),
  promptCacheKey: z.string().optional(),
});
export type StageMetrics = z.infer<typeof StageMetricsSchema>;

// ---------------------------------------------------------------------------
// RunMetrics — one scenario run rollup
// ---------------------------------------------------------------------------

export const RunMetricsSchema = z.object({
  runId: z.string(),
  scenarioId: z.string(),
  harness: HarnessSchema,
  provider: z.string(),
  modelName: z.string(),
  modelTier: ModelTierSchema,
  preRelease: z.boolean(),
  passAt1: z.boolean(),
  passAtK: z.boolean().optional(),
  stateHashMatch: z.boolean().optional(),
  startedAt: z.number(),
  endedAt: z.number(),
  timeToCompleteMs: z.number(),
  turns: z.array(TurnMetricsSchema),
  stages: z.array(StageMetricsSchema).optional(),
  totalInputTokens: z.number().int(),
  totalOutputTokens: z.number().int(),
  totalCacheReadTokens: z.number().int().nullable(),
  totalCacheCreationTokens: z.number().int().nullable(),
  aggregateCacheHitPct: z.number().min(0).max(1).nullable(),
  totalCostUsd: z.number().nonnegative(),
  plannerIterations: z.number().int().optional(),
  toolCallCount: z.number().int(),
  toolFailureCount: z.number().int(),
});
export type RunMetrics = z.infer<typeof RunMetricsSchema>;

// ---------------------------------------------------------------------------
// Report — top-level artifact written as `report.json`
// ---------------------------------------------------------------------------

export const REPORT_SCHEMA_VERSION = "lifeops-bench-v1" as const;

export const ReportRollupSchema = z.object({
  scenarioCount: z.number().int(),
  passCount: z.number().int(),
  passRate: z.number(),
  totalInputTokens: z.number().int(),
  totalOutputTokens: z.number().int(),
  totalCacheReadTokens: z.number().int().nullable(),
  aggregateCacheHitPct: z.number().min(0).max(1).nullable(),
  totalCostUsd: z.number().nonnegative(),
  totalTimeMs: z.number(),
});
export type ReportRollup = z.infer<typeof ReportRollupSchema>;

export const ReportSchema = z.object({
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  generatedAt: z.string(),
  runId: z.string(),
  harness: HarnessSchema,
  provider: z.string(),
  modelName: z.string(),
  modelTier: ModelTierSchema,
  preRelease: z.boolean(),
  scenarios: z.array(RunMetricsSchema),
  rollup: ReportRollupSchema,
  notes: z.array(z.string()).optional(),
});
export type Report = z.infer<typeof ReportSchema>;

// ---------------------------------------------------------------------------
// Delta — A/B comparison artifact written as `delta.json`
// ---------------------------------------------------------------------------

export const DELTA_SCHEMA_VERSION = "lifeops-bench-delta-v1" as const;

export const DeltaSidecarSchema = z.object({
  runId: z.string(),
  label: z.string(),
});
export type DeltaSidecar = z.infer<typeof DeltaSidecarSchema>;

export const DeltaScenarioSchema = z.object({
  scenarioId: z.string(),
  passBaseline: z.boolean(),
  passCandidate: z.boolean(),
  deltaCostUsd: z.number(),
  deltaLatencyMs: z.number(),
  deltaTotalTokens: z.number(),
  deltaCacheHitPct: z.number().nullable(),
});
export type DeltaScenario = z.infer<typeof DeltaScenarioSchema>;

export const DeltaRollupSchema = z.object({
  deltaPassRate: z.number(),
  deltaCostUsd: z.number(),
  deltaTotalTokens: z.number(),
  deltaCacheHitPct: z.number().nullable(),
  deltaTimeMs: z.number(),
});
export type DeltaRollup = z.infer<typeof DeltaRollupSchema>;

export const DeltaSchema = z.object({
  schemaVersion: z.literal(DELTA_SCHEMA_VERSION),
  generatedAt: z.string(),
  baseline: DeltaSidecarSchema,
  candidate: DeltaSidecarSchema,
  perScenario: z.array(DeltaScenarioSchema),
  rollup: DeltaRollupSchema,
});
export type Delta = z.infer<typeof DeltaSchema>;

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

export function parseReport(input: unknown): Report {
  return ReportSchema.parse(input);
}

export function parseDelta(input: unknown): Delta {
  return DeltaSchema.parse(input);
}

export function parseRunMetrics(input: unknown): RunMetrics {
  return RunMetricsSchema.parse(input);
}
