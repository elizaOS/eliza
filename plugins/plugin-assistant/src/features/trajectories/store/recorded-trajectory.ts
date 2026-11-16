/**
 * The recorded-trajectory shape (`RecordedTrajectory`) as a projection of the
 * trajectory row store. A row keeps each recorded trajectory's header in
 * `metadata.recordedTrajectories[id]` and its stages as semantic stages on the
 * row's steps. Metrics are never stored: they are derived from the stages, so
 * the row, a live export and a later export always agree.
 */
import {
  ElizaError,
  type JsonValue,
  type RecordedStage,
  type RecordedTrajectory,
  type RecordedTrajectoryMetrics,
  type RecorderLogger,
  type TrajectorySemanticStageRecord,
} from "@elizaos/core";
import {
  computeCallCostUsd,
  PRICE_TABLE_ID,
} from "../../../runtime/model-pricing";
import type { PersistedTrajectory } from "./trajectory-internals.ts";

/** Row metadata key that maps recorded-trajectory id to its header. */
export const RECORDED_TRAJECTORIES_METADATA_KEY = "recordedTrajectories";

/**
 * Everything in a `RecordedTrajectory` except its stages and metrics, plus the
 * ordered ids of its stages on the row. A turn row can carry stages of more
 * than one recorded trajectory, so the ids select this trajectory's stages.
 */
export type RecordedTrajectoryHeader = Omit<
  RecordedTrajectory,
  "stages" | "metrics"
> & { stageIds: string[] };

export function emptyRecordedTrajectoryMetrics(): RecordedTrajectoryMetrics {
  return {
    totalLatencyMs: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalReasoningTokens: 0,
    totalCostUsd: 0,
    plannerIterations: 0,
    toolCallsExecuted: 0,
    toolCallFailures: 0,
    toolSearchCount: 0,
    evaluatorFailures: 0,
  };
}

function applyMetricsForStage(
  metrics: RecordedTrajectoryMetrics,
  stage: RecordedStage,
): void {
  metrics.totalLatencyMs += Number.isFinite(stage.latencyMs)
    ? stage.latencyMs
    : 0;

  if (stage.model?.usage) {
    if (stage.model.usage.promptTokens !== undefined) {
      metrics.totalPromptTokens += stage.model.usage.promptTokens;
    }
    if (stage.model.usage.completionTokens !== undefined) {
      metrics.totalCompletionTokens += stage.model.usage.completionTokens;
    }
    metrics.totalCacheReadTokens += stage.model.usage.cacheReadInputTokens ?? 0;
    metrics.totalCacheCreationTokens +=
      stage.model.usage.cacheCreationInputTokens ?? 0;
    metrics.totalReasoningTokens =
      (metrics.totalReasoningTokens ?? 0) +
      (stage.model.usage.reasoningTokens ?? 0);
  }
  if (typeof stage.model?.costUsd === "number") {
    metrics.totalCostUsd += stage.model.costUsd;
  }

  if (stage.kind === "planner") metrics.plannerIterations += 1;
  if (stage.kind === "tool") {
    metrics.toolCallsExecuted += 1;
    if (stage.tool && !stage.tool.success) metrics.toolCallFailures += 1;
  }
  if (stage.kind === "toolSearch") metrics.toolSearchCount += 1;
  if (
    stage.kind === "evaluation" &&
    ((typeof stage.evaluation?.parseError === "string" &&
      stage.evaluation.parseError.trim().length > 0) ||
      stage.evaluation?.protocolFailure === true)
  ) {
    metrics.evaluatorFailures += 1;
  }

  const decision = stage.evaluation?.decision;
  if (decision === "FINISH") {
    metrics.finalDecision = "FINISH";
  } else if (decision) {
    metrics.finalDecision = "CONTINUE";
  }
}

/**
 * Derive a recorded trajectory's metrics from its stages and status.
 *
 * Non-evaluated terminal paths (Stage-1 direct reply, deterministic fallback,
 * structured failure reply) finish without an evaluation stage. An absent
 * finalDecision on a finished trajectory reads as "died mid-turn", so a clean
 * finish is stamped "FINISH" and an errored one "error". Both are members of
 * the canonical validator's closed vocabulary
 * (packages/scripts/lib/trajectory-validate.ts).
 */
export function rollupRecordedTrajectoryMetrics(
  stages: readonly RecordedStage[],
  status: RecordedTrajectory["status"],
): RecordedTrajectoryMetrics {
  const metrics = emptyRecordedTrajectoryMetrics();
  for (const stage of stages) applyMetricsForStage(metrics, stage);
  if (status === "errored" && !metrics.finalDecision) {
    metrics.finalDecision = "error";
  }
  if (status === "finished" && !metrics.finalDecision) {
    metrics.finalDecision = "FINISH";
  }
  return metrics;
}

/** The per-file `RecordedTrajectory` for a header and its ordered stages. */
export function buildRecordedTrajectory(
  header: RecordedTrajectoryHeader,
  stages: readonly RecordedStage[],
): RecordedTrajectory {
  const { stageIds: _stageIds, ...rest } = header;
  return {
    ...rest,
    stages: [...stages],
    metrics: rollupRecordedTrajectoryMetrics(stages, header.status),
  };
}

/**
 * Annotate a stage with `costUsd` and `priceTableId` if the model has known
 * pricing and the stage did not already set it. `model.modelName` is the
 * lookup key; `model.provider` suppresses the missing-model warning for
 * local-tier inference (Ollama, LM Studio, llama.cpp).
 */
export function annotateStageCost(
  stage: RecordedStage,
  logger?: RecorderLogger,
): void {
  if (!stage.model) return;
  if (typeof stage.model.costUsd === "number") {
    // Caller already attached a cost; only tag the table id so consumers
    // know which snapshot it was computed against.
    if (!stage.model.priceTableId) {
      stage.model.priceTableId = PRICE_TABLE_ID;
    }
    return;
  }
  const cost = computeCallCostUsd(stage.model.modelName, stage.model.usage, {
    provider: stage.model.provider,
    logger,
  });
  if (cost !== undefined) {
    stage.model.costUsd = cost;
    stage.model.priceTableId = PRICE_TABLE_ID;
  }
}

/** The runtime recorder stage that a stored semantic stage was written from. */
export function recordedStageFromSemanticStage(
  semantic: TrajectorySemanticStageRecord,
): RecordedStage {
  return {
    stageId: semantic.stageId,
    kind: semantic.kind,
    ...(semantic.iteration !== undefined
      ? { iteration: semantic.iteration }
      : {}),
    ...(semantic.retryIdx !== undefined ? { retryIdx: semantic.retryIdx } : {}),
    ...(semantic.parentStageId
      ? { parentStageId: semantic.parentStageId }
      : {}),
    startedAt: semantic.startedAt,
    endedAt: semantic.endedAt,
    latencyMs: semantic.latencyMs,
    ...(semantic.payload as unknown as Partial<RecordedStage>),
  } as RecordedStage;
}

function invalidHeader(trajectoryId: string, field: string): ElizaError {
  return new ElizaError("Stored recorded-trajectory header is invalid", {
    code: "TRAJECTORY_RECORDED_HEADER_INVALID",
    context: { trajectoryId, field },
  });
}

function parseRecordedTrajectoryHeader(
  key: string,
  value: unknown,
): RecordedTrajectoryHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidHeader(key, "header");
  }
  const header = value as Record<string, unknown>;
  if (header.trajectoryId !== key) throw invalidHeader(key, "trajectoryId");
  if (typeof header.agentId !== "string") throw invalidHeader(key, "agentId");
  if (typeof header.startedAt !== "number") {
    throw invalidHeader(key, "startedAt");
  }
  if (
    header.status !== "running" &&
    header.status !== "finished" &&
    header.status !== "errored"
  ) {
    throw invalidHeader(key, "status");
  }
  const rootMessage = header.rootMessage as Record<string, unknown> | null;
  if (
    !rootMessage ||
    typeof rootMessage !== "object" ||
    typeof rootMessage.id !== "string" ||
    typeof rootMessage.text !== "string"
  ) {
    throw invalidHeader(key, "rootMessage");
  }
  if (
    !Array.isArray(header.stageIds) ||
    !header.stageIds.every((id) => typeof id === "string")
  ) {
    throw invalidHeader(key, "stageIds");
  }
  return header as unknown as RecordedTrajectoryHeader;
}

/** The recorded-trajectory headers a row's metadata carries, by id. */
export function readRecordedTrajectoryHeaders(
  metadata: Record<string, unknown> | undefined,
): Map<string, RecordedTrajectoryHeader> {
  const headers = new Map<string, RecordedTrajectoryHeader>();
  const stored = metadata?.[RECORDED_TRAJECTORIES_METADATA_KEY];
  if (stored === undefined) return headers;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    throw invalidHeader("*", RECORDED_TRAJECTORIES_METADATA_KEY);
  }
  for (const [key, value] of Object.entries(stored)) {
    headers.set(key, parseRecordedTrajectoryHeader(key, value));
  }
  return headers;
}

/** Row metadata with one recorded-trajectory header set (stage ids kept). */
export function withRecordedTrajectoryHeader(
  metadata: Record<string, unknown>,
  header: RecordedTrajectoryHeader,
): Record<string, unknown> {
  const stored = metadata[RECORDED_TRAJECTORIES_METADATA_KEY];
  const map =
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, JsonValue>)
      : {};
  const existing = map[header.trajectoryId] as
    | { stageIds?: unknown }
    | undefined;
  const stageIds = Array.isArray(existing?.stageIds)
    ? (existing.stageIds as string[])
    : header.stageIds;
  return {
    ...metadata,
    [RECORDED_TRAJECTORIES_METADATA_KEY]: {
      ...map,
      [header.trajectoryId]: { ...header, stageIds },
    },
  };
}

/** Row metadata with one stage id appended to a recorded-trajectory header. */
export function withRecordedTrajectoryStage(
  metadata: Record<string, unknown>,
  recordedTrajectoryId: string,
  stageId: string,
): Record<string, unknown> {
  const header =
    readRecordedTrajectoryHeaders(metadata).get(recordedTrajectoryId);
  if (!header) {
    throw new ElizaError("Recorded-trajectory header is missing on the row", {
      code: "TRAJECTORY_RECORDED_HEADER_MISSING",
      context: { trajectoryId: recordedTrajectoryId, stageId },
    });
  }
  const stored = metadata[RECORDED_TRAJECTORIES_METADATA_KEY] as Record<
    string,
    JsonValue
  >;
  return {
    ...metadata,
    [RECORDED_TRAJECTORIES_METADATA_KEY]: {
      ...stored,
      [recordedTrajectoryId]: {
        ...header,
        stageIds: [...header.stageIds, stageId],
      },
    },
  };
}

function terminalRecordedStatus(
  trajectory: PersistedTrajectory,
): RecordedTrajectory["status"] {
  if (trajectory.status === "active") return "running";
  return trajectory.status === "completed" ? "finished" : "errored";
}

/**
 * Every recorded trajectory a stored row carries, in the per-file format.
 * A header still `running` on a terminal row (its end arrived after the turn
 * row closed) takes the row's terminal status and end time.
 */
export function projectRecordedTrajectories(
  trajectory: PersistedTrajectory,
): RecordedTrajectory[] {
  const headers = readRecordedTrajectoryHeaders(trajectory.metadata);
  if (headers.size === 0) return [];
  const stagesById = new Map<string, RecordedStage>();
  for (const step of trajectory.steps) {
    for (const semantic of step.semanticStages ?? []) {
      stagesById.set(
        semantic.stageId,
        recordedStageFromSemanticStage(semantic),
      );
    }
  }
  const out: RecordedTrajectory[] = [];
  for (const header of headers.values()) {
    const stages = header.stageIds.map((stageId) => {
      const stage = stagesById.get(stageId);
      if (!stage) {
        throw new ElizaError(
          "Recorded-trajectory stage is missing on the row",
          {
            code: "TRAJECTORY_RECORDED_STAGE_MISSING",
            context: { trajectoryId: header.trajectoryId, stageId },
          },
        );
      }
      return stage;
    });
    const settled: RecordedTrajectoryHeader =
      header.status === "running" && trajectory.status !== "active"
        ? {
            ...header,
            status: terminalRecordedStatus(trajectory),
            ...(typeof trajectory.endTime === "number"
              ? { endedAt: trajectory.endTime }
              : {}),
          }
        : header;
    out.push(buildRecordedTrajectory(settled, stages));
  }
  return out;
}
