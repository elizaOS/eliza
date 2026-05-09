/**
 * Trajectory export — export and archive operations.
 *
 * Re-exports archive helpers and hosts the shared canonical list/detail/export
 * shaping used by the agent runtime trajectory logger implementations.
 */

import { type JsonValue, serializeTrajectoryExport } from "@elizaos/core";
import type {
  Trajectory,
  TrajectoryExportOptions,
  TrajectoryExportResult,
  TrajectoryListItem,
  TrajectoryLlmCall,
  TrajectoryProviderAccess,
  TrajectoryStep,
} from "../types/trajectory.js";
import {
  enrichTrajectoryLlmCall,
  normalizeStatus,
  normalizeTrajectoryMetadata,
  type PersistedLlmCall,
  type PersistedProviderAccess,
  type PersistedStep,
  type PersistedTrajectory,
  parseMetadata,
  toNumber,
  toOptionalNumber,
  toText,
} from "./trajectory-internals.js";

export type RuntimeTrajectoryExportOptions = TrajectoryExportOptions;

function toCreatedAt(timestamp: number | undefined): string {
  return new Date(timestamp ?? Date.now()).toISOString();
}

function toPublicTrajectoryLlmCall(
  call: PersistedLlmCall,
  trajectoryId: string,
  stepId: string,
): TrajectoryLlmCall {
  return enrichTrajectoryLlmCall({
    ...call,
    callId: toText(call.callId, `${stepId}-call`),
    stepId,
    trajectoryId,
    timestamp: toNumber(call.timestamp, Date.now()),
    model: toText(call.model, "unknown"),
    systemPrompt: toText(call.systemPrompt, ""),
    userPrompt: toText(call.userPrompt, ""),
    response: toText(call.response, ""),
    temperature: toNumber(call.temperature, 0),
    maxTokens: toNumber(call.maxTokens, 0),
    purpose: toText(call.purpose, "action"),
    actionType: toText(call.actionType, "runtime.useModel"),
    latencyMs: toNumber(call.latencyMs, 0),
    ...(call.createdAt
      ? { createdAt: toText(call.createdAt, toCreatedAt(call.timestamp)) }
      : { createdAt: toCreatedAt(call.timestamp) }),
  }) as TrajectoryLlmCall;
}

function toPublicTrajectoryProviderAccess(
  access: PersistedProviderAccess,
  trajectoryId: string,
  stepId: string,
): TrajectoryProviderAccess {
  return {
    ...access,
    providerId: toText(access.providerId, `${stepId}-provider`),
    stepId,
    trajectoryId,
    providerName: toText(access.providerName, "unknown"),
    purpose: toText(access.purpose, "provider"),
    data: access.data && typeof access.data === "object" ? access.data : {},
    timestamp: toNumber(access.timestamp, Date.now()),
    ...(access.createdAt
      ? { createdAt: toText(access.createdAt, toCreatedAt(access.timestamp)) }
      : { createdAt: toCreatedAt(access.timestamp) }),
  };
}

function toPublicTrajectoryStep(
  step: PersistedStep,
  trajectoryId: string,
): TrajectoryStep {
  return {
    ...step,
    stepId: toText(step.stepId, trajectoryId),
    timestamp: toNumber(step.timestamp, Date.now()),
    llmCalls: (step.llmCalls ?? []).map((call) =>
      toPublicTrajectoryLlmCall(
        call,
        trajectoryId,
        toText(step.stepId, trajectoryId),
      ),
    ),
    providerAccesses: (step.providerAccesses ?? []).map((access) =>
      toPublicTrajectoryProviderAccess(
        access,
        trajectoryId,
        toText(step.stepId, trajectoryId),
      ),
    ),
  };
}

export function trajectoryRowToListItem(
  row: unknown,
  agentId: string,
): TrajectoryListItem | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const normalizedMetadata = normalizeTrajectoryMetadata(
    parseMetadata(record.metadata),
    {
      scenarioId: record.scenario_id,
      batchId: record.batch_id,
    },
  );

  return {
    id: toText(record.id ?? record.trajectory_id, ""),
    agentId: toText(record.agent_id, agentId),
    source: toText(record.source, "runtime"),
    status: normalizeStatus(record.status, "completed"),
    startTime: toNumber(record.start_time, Date.now()),
    endTime: toOptionalNumber(record.end_time) ?? null,
    durationMs: toOptionalNumber(record.duration_ms) ?? null,
    stepCount: toNumber(record.step_count, 0),
    llmCallCount: toNumber(record.llm_call_count, 0),
    providerAccessCount: toNumber(record.provider_access_count, 0),
    totalPromptTokens: toNumber(record.total_prompt_tokens, 0),
    totalCompletionTokens: toNumber(record.total_completion_tokens, 0),
    scenarioId: normalizedMetadata.scenarioId,
    batchId: normalizedMetadata.batchId,
    createdAt: toText(
      record.created_at,
      new Date(toNumber(record.start_time, Date.now())).toISOString(),
    ),
    metadata: normalizedMetadata.metadata as Record<
      string,
      JsonValue | undefined
    >,
  };
}

export function persistedTrajectoryToDetailRecord(
  persisted: PersistedTrajectory,
  agentId: string,
): Trajectory {
  const endTime =
    typeof persisted.endTime === "number" ? persisted.endTime : undefined;
  return {
    trajectoryId: persisted.id,
    agentId,
    source: persisted.source,
    status: persisted.status,
    startTime: persisted.startTime,
    ...(endTime !== undefined ? { endTime } : {}),
    ...(endTime !== undefined
      ? { durationMs: Math.max(0, endTime - persisted.startTime) }
      : {}),
    ...(persisted.scenarioId ? { scenarioId: persisted.scenarioId } : {}),
    ...(persisted.batchId ? { batchId: persisted.batchId } : {}),
    steps: (persisted.steps ?? []).map((step) =>
      toPublicTrajectoryStep(step, persisted.id),
    ),
    metrics: { finalStatus: persisted.status },
    metadata: persisted.metadata as Record<string, JsonValue | undefined>,
    stepsJson: JSON.stringify(persisted.steps ?? []),
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
} from "./trajectory-internals.js";
