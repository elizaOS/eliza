/**
 * Trajectory export — export and archive operations.
 *
 * Re-exports archive helpers and hosts the shared canonical list/detail/export
 * shaping used by the agent runtime trajectory logger implementations.
 */

import {
  ElizaError,
  type JsonValue,
  serializeTrajectoryExport,
} from "@elizaos/core";
import type {
  Trajectory,
  TrajectoryExportOptions,
  TrajectoryExportResult,
  TrajectoryListItem,
  TrajectoryLlmCall,
  TrajectoryProviderAccess,
  TrajectoryStep,
} from "../types/trajectory.ts";
import {
  enrichTrajectoryLlmCall,
  normalizePersistedTrajectoryTiming,
  type PersistedLlmCall,
  type PersistedProviderAccess,
  type PersistedStep,
  type PersistedTrajectory,
  parsePersistedTrajectoryRow,
  toOptionalNumber,
} from "./trajectory-internals.ts";

export type RuntimeTrajectoryExportOptions = TrajectoryExportOptions;

function toPublicTrajectoryLlmCall(
  call: PersistedLlmCall,
  trajectoryId: string,
  stepId: string,
): TrajectoryLlmCall {
  return enrichTrajectoryLlmCall({
    ...call,
    stepId,
    trajectoryId,
  }) as TrajectoryLlmCall;
}

function toPublicTrajectoryProviderAccess(
  access: PersistedProviderAccess,
  trajectoryId: string,
  stepId: string,
): TrajectoryProviderAccess {
  return {
    ...access,
    stepId,
    trajectoryId,
  };
}

/**
 * Map a persisted step into the public step record shape.
 *
 * Does not invent an `action` field: Agent-bridge LLM-only captures are
 * actionless by design (#17730). `TrajectoryStep` here is
 * `TrajectoryStepRecord` (no required action). Training-side
 * `features/trajectories` `TrajectoryStep.action` is optional for the same
 * reason; ART conversion guards absence rather than assuming every step acted.
 */
function toPublicTrajectoryStep(
  step: PersistedStep,
  trajectoryId: string,
): TrajectoryStep {
  return {
    ...step,
    llmCalls: (step.llmCalls as PersistedLlmCall[]).map((call) =>
      toPublicTrajectoryLlmCall(call, trajectoryId, step.stepId),
    ),
    providerAccesses: (step.providerAccesses as PersistedProviderAccess[]).map(
      (access) =>
        toPublicTrajectoryProviderAccess(access, trajectoryId, step.stepId),
    ),
  };
}

export function trajectoryRowToListItem(
  row: unknown,
  agentId: string,
): TrajectoryListItem {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new ElizaError("Trajectory list row is invalid", {
      code: "TRAJECTORY_ROW_INVALID",
      context: { field: "row" },
    });
  }
  const record = row as Record<string, unknown>;
  const persisted = parsePersistedTrajectoryRow(
    record,
    typeof record.id === "string" ? record.id : "unknown",
  );
  if (persisted.agentId !== agentId) {
    throw new ElizaError("Trajectory list row belongs to another agent", {
      code: "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
      context: {
        trajectoryId: persisted.id,
        rowAgentId: persisted.agentId,
        runtimeAgentId: agentId,
      },
    });
  }
  const requiredCount = (field: string): number => {
    const value = toOptionalNumber(record[field]);
    if (value === undefined || !Number.isInteger(value) || value < 0) {
      throw new ElizaError("Trajectory list count is invalid", {
        code: "TRAJECTORY_ROW_INVALID",
        context: { trajectoryId: persisted.id, field },
      });
    }
    return value;
  };
  const durationMs =
    persisted.endTime === null ? null : persisted.endTime - persisted.startTime;

  return {
    id: persisted.id,
    agentId: persisted.agentId,
    source: persisted.source,
    status: persisted.status,
    startTime: persisted.startTime,
    endTime: persisted.endTime,
    durationMs,
    stepCount: requiredCount("step_count"),
    llmCallCount: requiredCount("llm_call_count"),
    providerAccessCount: requiredCount("provider_access_count"),
    totalPromptTokens: requiredCount("total_prompt_tokens"),
    totalCompletionTokens: requiredCount("total_completion_tokens"),
    totalCacheReadInputTokens: requiredCount("total_cache_read_input_tokens"),
    totalCacheCreationInputTokens: requiredCount(
      "total_cache_creation_input_tokens",
    ),
    scenarioId: persisted.scenarioId,
    batchId: persisted.batchId,
    createdAt: persisted.createdAt,
    updatedAt: persisted.updatedAt,
    roomId:
      typeof persisted.metadata.roomId === "string"
        ? persisted.metadata.roomId
        : null,
    entityId:
      typeof persisted.metadata.entityId === "string"
        ? persisted.metadata.entityId
        : null,
    conversationId:
      typeof persisted.metadata.conversationId === "string"
        ? persisted.metadata.conversationId
        : null,
    metadata: persisted.metadata as Record<string, JsonValue | undefined>,
  };
}

export function persistedTrajectoryToDetailRecord(
  persisted: PersistedTrajectory,
  agentId: string,
): Trajectory {
  if (persisted.agentId !== agentId) {
    throw new ElizaError("Trajectory detail belongs to another agent", {
      code: "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
      context: {
        trajectoryId: persisted.id,
        trajectoryAgentId: persisted.agentId,
        runtimeAgentId: agentId,
      },
    });
  }
  const timing = normalizePersistedTrajectoryTiming({
    status: persisted.status,
    startTime: persisted.startTime,
    endTime: persisted.endTime,
    createdAt: persisted.createdAt,
    updatedAt: persisted.updatedAt,
  });
  const endTime = timing.endTime ?? undefined;
  return {
    trajectoryId: persisted.id,
    agentId: persisted.agentId,
    source: persisted.source,
    status: persisted.status,
    startTime: persisted.startTime,
    ...(endTime !== undefined ? { endTime } : {}),
    ...(timing.durationMs !== null ? { durationMs: timing.durationMs } : {}),
    ...(persisted.scenarioId ? { scenarioId: persisted.scenarioId } : {}),
    ...(persisted.batchId ? { batchId: persisted.batchId } : {}),
    steps: persisted.steps.map((step) =>
      toPublicTrajectoryStep(step, persisted.id),
    ),
    // Viewer + Core duck contracts require episodeLength + finalStatus on
    // metrics. Actionless LLM steps stay action-optional; read routes map
    // those to toolEvents: [] without fabrication (#17730).
    metrics: {
      ...persisted.metrics,
      episodeLength: persisted.steps.length,
      finalStatus: persisted.status,
    },
    metadata: persisted.metadata as Record<string, JsonValue | undefined>,
    stepsJson: JSON.stringify(persisted.steps),
  };
}

export function exportPersistedTrajectories(params: {
  agentId: string;
  persistedTrajectories: PersistedTrajectory[];
  options: RuntimeTrajectoryExportOptions;
}): TrajectoryExportResult {
  const { agentId, persistedTrajectories, options } = params;
  const trajectories = persistedTrajectories.map((trajectory) =>
    persistedTrajectoryToDetailRecord(trajectory, agentId),
  );
  return serializeTrajectoryExport(trajectories, options);
}

export {
  ensureArchiveDirectory,
  resolvePreferredTrajectoryArchiveRoot,
  resolveTrajectoryArchiveDirectory,
  stringifyArchiveRow,
  TRAJECTORY_ARCHIVE_DIRNAME,
  toArchiveSafeTimestamp,
  writeCompressedJsonlRows,
} from "./trajectory-internals.ts";
