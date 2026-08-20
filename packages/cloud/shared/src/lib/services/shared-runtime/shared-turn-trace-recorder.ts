/**
 * Sampled, flag-gated, off-path observability for Shared (Tier-0) agent turns.
 *
 * Shared turns run with `enableTrajectories: false` because full trajectory
 * capture costs latency and storage on the interactive hot path. This module
 * is the deliberate replacement: after a turn completes, the caller builds a
 * COMPACT summary (stage names, durations, tool names, finish reason, token
 * usage — never prompt or response text) and hands it to the recorder, which
 * persists it only when `SHARED_TURN_TRACES_ENABLED === "true"` AND the turn's
 * `trace_id` falls inside the deterministic sample.
 *
 * Sampling hashes the trace id (FNV-1a) instead of drawing randomness so the
 * same turn always makes the same keep/drop decision — retries and mirrored
 * writers agree, and tests are reproducible. The recorder never throws: a
 * failed insert is diagnostics loss, not a turn failure.
 */

import type {
  NewSharedTurnTraceRow,
  SharedTurnTraceFinishReason,
  SharedTurnTraceStage,
  SharedTurnTraceUsage,
} from "../../../db/schemas/shared-turn-traces";
import { logger } from "../../utils/logger";
import type { RunSharedAgentTurnResult, SharedAgentTurnUsage } from "./run-shared-agent-turn";
import type { SharedRuntimeTimingReceipt } from "./shared-runtime-timing";

/** Default keep fraction when `SHARED_TURN_TRACES_SAMPLE` is unset or invalid. */
export const DEFAULT_SHARED_TURN_TRACES_SAMPLE = 0.1;

/** Cap on recorded action stages so a pathological turn cannot bloat the row. */
const MAX_ACTION_STAGES = 16;

/** Everything the recorder persists about one completed Shared turn. */
export interface SharedTurnSummary {
  organizationId: string;
  userId: string;
  agentId: string;
  channelId?: string;
  /** Stable turn identity; also the deterministic sampling key. */
  traceId: string;
  /** Epoch-ms turn start. */
  startedAt: number;
  latencyMs: number;
  model: string;
  usage?: SharedAgentTurnUsage;
  finishReason: SharedTurnTraceFinishReason;
  stages: SharedTurnTraceStage[];
  /** Terminal runtime receipt persisted under this row's single sample decision. */
  terminalTiming?: SharedRuntimeTimingReceipt;
}

export interface SharedTurnTraceRecorderDeps {
  /** Scoped insert, normally `sharedTurnTracesRepository.insertTrace`. */
  insertTrace: (trace: NewSharedTurnTraceRow) => Promise<void>;
  /** Env override for tests; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * Parse `SHARED_TURN_TRACES_SAMPLE` defensively: unset/blank/non-finite input
 * falls back to the default, and any finite value is clamped into [0, 1] so a
 * typo can never over-sample production.
 */
export function resolveSharedTurnTraceSampleRate(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SHARED_TURN_TRACES_SAMPLE;
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_SHARED_TURN_TRACES_SAMPLE;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return DEFAULT_SHARED_TURN_TRACES_SAMPLE;
  return Math.min(Math.max(parsed, 0), 1);
}

/** FNV-1a 32-bit hash of the trace id mapped onto the unit interval [0, 1). */
function traceIdUnitInterval(traceId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < traceId.length; index += 1) {
    hash ^= traceId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/**
 * Deterministic keep/drop decision for one trace id at the given sample rate.
 * No randomness: the same id and rate always agree, across processes and time.
 */
export function isSharedTurnTraceSampled(traceId: string, sampleRate: number): boolean {
  if (!(sampleRate > 0)) return false;
  if (sampleRate >= 1) return true;
  return traceIdUnitInterval(traceId) < sampleRate;
}

/** Copy only the numeric token fields so no provider metadata rides into the row. */
function compactUsage(usage: SharedAgentTurnUsage): SharedTurnTraceUsage | undefined {
  const compact: SharedTurnTraceUsage = {};
  for (const key of [
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "inputTokens",
    "outputTokens",
  ] as const) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) compact[key] = value;
  }
  return Object.keys(compact).length > 0 ? compact : undefined;
}

/** The result fields the summary derives from; the reply/history text is never read. */
export type SharedTurnSummaryResult = Pick<
  RunSharedAgentTurnResult,
  "model" | "degraded" | "usage" | "actionResults" | "capabilityWall"
>;

export interface BuildTurnSummaryInput {
  result: SharedTurnSummaryResult;
  organizationId: string;
  userId: string;
  agentId: string;
  channelId?: string;
  traceId: string;
  /** Epoch-ms turn start captured by the caller before dispatch. */
  startedAt: number;
  /** Epoch-ms turn completion; pass it so latency stays deterministic in tests. */
  completedAt: number;
}

/**
 * Derive the compact stage list from what `runSharedAgentTurn` already
 * returns. Only structural facts are read — model id, degrade flag, usage
 * numbers, registered action names (`data.actionName`), and capability labels.
 * Reply text, history, prompts, and action payload text are deliberately never
 * copied into the summary.
 */
export function buildTurnSummary(input: BuildTurnSummaryInput): SharedTurnSummary {
  const { result } = input;
  let finishReason: SharedTurnTraceFinishReason;
  const stages: SharedTurnTraceStage[] = [];
  if (result.capabilityWall) {
    finishReason = "capability-wall";
    stages.push({ name: "capability-wall", tool: result.capabilityWall.capability });
  } else if (result.degraded) {
    finishReason = "degraded";
    stages.push({ name: "unavailable" });
  } else {
    finishReason = "reply";
    stages.push({ name: "model" });
    for (const actionResult of (result.actionResults ?? []).slice(0, MAX_ACTION_STAGES)) {
      const actionName = actionResult.data?.actionName;
      stages.push({
        name: "action",
        ...(typeof actionName === "string" && actionName.length > 0 ? { tool: actionName } : {}),
      });
    }
  }
  return {
    organizationId: input.organizationId,
    userId: input.userId,
    agentId: input.agentId,
    ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
    traceId: input.traceId,
    startedAt: input.startedAt,
    latencyMs: Math.max(0, Math.round(input.completedAt - input.startedAt)),
    model: result.model,
    ...(result.usage ? { usage: result.usage } : {}),
    finishReason,
    stages,
  };
}

/**
 * Persist one sampled turn trace. Returns true only when a row was written.
 * Gated first on `SHARED_TURN_TRACES_ENABLED === "true"` (exact match — the
 * feature is opt-in and off by default), then on the deterministic sample.
 */
export async function recordSharedTurnTrace(
  deps: SharedTurnTraceRecorderDeps,
  summary: SharedTurnSummary,
): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (env.SHARED_TURN_TRACES_ENABLED !== "true") return false;
  const sampleRate = resolveSharedTurnTraceSampleRate(env.SHARED_TURN_TRACES_SAMPLE);
  if (!isSharedTurnTraceSampled(summary.traceId, sampleRate)) return false;
  const compactedUsage = summary.usage ? compactUsage(summary.usage) : undefined;
  try {
    await deps.insertTrace({
      organization_id: summary.organizationId,
      user_id: summary.userId,
      agent_id: summary.agentId,
      channel_id: summary.channelId ?? null,
      trace_id: summary.traceId,
      started_at: new Date(summary.startedAt),
      latency_ms: Math.max(0, Math.round(summary.latencyMs)),
      model: summary.model,
      ...(compactedUsage ? { usage: compactedUsage } : {}),
      stages: {
        finishReason: summary.finishReason,
        stages: summary.stages,
        ...(summary.terminalTiming ? { terminalTiming: summary.terminalTiming } : {}),
      },
    });
    return true;
  } catch (error) {
    // error-policy:J7 diagnostics must not kill the loop: the user's turn
    // already completed; losing one sampled trace is warned, never rethrown
    // into the turn path.
    logger.warn("[shared-turn-trace-recorder] sampled trace insert failed", {
      error: error instanceof Error ? error.message : String(error),
      organizationId: summary.organizationId,
      agentId: summary.agentId,
      traceId: summary.traceId,
    });
    return false;
  }
}
