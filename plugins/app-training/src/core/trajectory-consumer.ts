import type {
  Trajectory,
  TrajectoryLlmCall,
  TrajectoryStep,
} from "@elizaos/agent/types/trajectory";
import {
  buildContextObjectTrajectoryExport,
  buildTrajectoryHarnessRows,
  type TrajectoryDetailRecord as CoreTrajectoryDetailRecord,
  type TrajectoryHarnessExportRow,
} from "@elizaos/core";

export type TrainingTrajectoryJsonShape =
  | "legacy"
  | "context_object_events_v5"
  | "harness_v1";

export interface TrajectoryCallEntry {
  trajectory: Trajectory;
  trajectoryId: string;
  step: TrajectoryStep;
  stepId: string;
  stepIndex: number;
  call: TrajectoryLlmCall;
  callIndex: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTrajectoryStep(value: unknown): value is TrajectoryStep {
  return isRecord(value);
}

export function isTrajectoryLike(value: unknown): value is Trajectory {
  return (
    isRecord(value) &&
    typeof value.trajectoryId === "string" &&
    Array.isArray(value.steps) &&
    value.steps.every(isTrajectoryStep)
  );
}

function isHarnessExportRow(value: unknown): value is TrajectoryHarnessExportRow {
  return (
    isRecord(value) &&
    value.format === "trajectory_harness_v1" &&
    typeof value.trajectoryId === "string" &&
    typeof value.agentId === "string" &&
    typeof value.stepId === "string"
  );
}

function reconstructTrajectoriesFromHarnessRows(
  rows: readonly TrajectoryHarnessExportRow[],
): Trajectory[] {
  const trajectories = new Map<
    string,
    {
      trajectory: Trajectory;
      steps: Map<string, TrajectoryStep>;
    }
  >();

  for (const row of rows) {
    let entry = trajectories.get(row.trajectoryId);
    if (!entry) {
      entry = {
        trajectory: {
          trajectoryId: row.trajectoryId as Trajectory["trajectoryId"],
          agentId: row.agentId as Trajectory["agentId"],
          source: row.source,
          status: row.status,
          startTime: row.startTime,
          endTime: row.endTime ?? row.startTime,
          durationMs: row.durationMs ?? 0,
          scenarioId: row.scenarioId,
          batchId: row.batchId,
          steps: [],
          metrics: {
            finalStatus:
              row.status === "error" ||
              row.status === "timeout"
                ? row.status
                : "completed",
          },
          metadata: {
            source: row.source,
          },
        },
        steps: new Map<string, TrajectoryStep>(),
      };
      trajectories.set(row.trajectoryId, entry);
    }

    const stepKey = row.stepId;
    let step = entry.steps.get(stepKey);
    if (!step) {
      step = {
        stepId: row.stepId as TrajectoryStep["stepId"],
        timestamp: row.stepTimestamp,
        llmCalls: [],
        providerAccesses: [],
      };
      entry.steps.set(stepKey, step);
      (entry.trajectory.steps ||= []).push(step);
    }

    (step.llmCalls ??= []).push({
      callId:
        typeof row.callId === "string" && row.callId.trim().length > 0
          ? row.callId
          : `${row.stepId}-call-${row.callIndex + 1}`,
      timestamp: row.timestamp ?? row.stepTimestamp,
      model: row.model ?? "unknown",
      modelVersion: row.modelVersion,
      systemPrompt: row.systemPrompt ?? "",
      userPrompt: row.userPrompt ?? "",
      response: row.response ?? "",
      reasoning: row.reasoning,
      temperature: row.temperature ?? 0,
      maxTokens: row.maxTokens ?? 0,
      topP: row.topP,
      purpose: row.purpose ?? "response",
      actionType: row.actionType,
      stepType: row.stepType,
      tags: Array.isArray(row.tags) ? row.tags : [],
      latencyMs: row.latencyMs,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      cacheReadInputTokens: row.cacheReadInputTokens,
      cacheCreationInputTokens: row.cacheCreationInputTokens,
      modelSlot: row.modelSlot,
      runId: row.runId,
      roomId: row.roomId,
      messageId: row.messageId,
      executionTraceId: row.executionTraceId,
    });
  }

  return [...trajectories.values()].map(({ trajectory }) => {
    const trajectorySteps = trajectory.steps ?? [];
    trajectorySteps.sort(
      (left, right) => left.timestamp - right.timestamp,
    );
    for (const step of trajectorySteps) {
      const calls = step.llmCalls ?? [];
      calls.sort(
        (left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0),
      );
      step.llmCalls = calls;
    }
    trajectory.steps = trajectorySteps;
    return trajectory;
  });
}

export function parseTrajectoryExportText(payload: string): unknown[] {
  const trimmed = payload.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  }

  if (trimmed.startsWith("{")) {
    return [JSON.parse(trimmed) as unknown];
  }

  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

export function extractTrajectoriesFromExportText(payload: string): Trajectory[] {
  const records = parseTrajectoryExportText(payload);
  const trajectories = records.filter(isTrajectoryLike);
  if (trajectories.length > 0) {
    return trajectories;
  }
  const harnessRows = records.filter(isHarnessExportRow);
  if (harnessRows.length > 0) {
    return reconstructTrajectoriesFromHarnessRows(harnessRows);
  }
  return [];
}

export function serializeExportRecordsAsJsonl(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

export function listTrajectoryCallEntries(
  trajectory: Trajectory,
): TrajectoryCallEntry[] {
  const trajectoryId = String(trajectory.trajectoryId);
  const entries: TrajectoryCallEntry[] = [];

  const steps = trajectory.steps ?? [];
  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex];
    if (!step) continue;
    const stepId =
      typeof step.stepId === "string" && step.stepId.trim().length > 0
        ? step.stepId
        : `${trajectoryId}-step-${stepIndex + 1}`;

    for (let callIndex = 0; callIndex < (step.llmCalls ?? []).length; callIndex++) {
      const call = step.llmCalls?.[callIndex];
      if (!call) continue;
      entries.push({
        trajectory,
        trajectoryId,
        step,
        stepId,
        stepIndex,
        call,
        callIndex,
      });
    }
  }

  return entries;
}

function redactTrajectoryPrompts(trajectory: Trajectory): Trajectory {
  return {
    ...trajectory,
    steps: (trajectory.steps ?? []).map((step) => ({
      ...step,
      llmCalls: (step.llmCalls ?? []).map((call) => ({
        ...call,
        systemPrompt: "",
        userPrompt: "",
      })),
    })),
  };
}

export function serializeTrajectoryExportAsJsonl(
  trajectories: readonly Trajectory[],
  options?: {
    includePrompts?: boolean;
    jsonShape?: TrainingTrajectoryJsonShape;
  },
): string {
  const rows =
    options?.jsonShape === "context_object_events_v5"
      ? trajectories.map((trajectory) =>
          buildContextObjectTrajectoryExport({
            trajectory: trajectory as unknown as Parameters<
              typeof buildContextObjectTrajectoryExport
            >[0]["trajectory"],
          }),
        )
      : options?.jsonShape === "harness_v1"
        ? buildTrajectoryHarnessRows(
            trajectories as readonly CoreTrajectoryDetailRecord[],
            {
              includePrompts: options?.includePrompts,
            },
          )
      : trajectories.map((trajectory) =>
          options?.includePrompts === false
            ? redactTrajectoryPrompts(trajectory)
            : trajectory,
        );

  return rows.map((row) => JSON.stringify(row)).join("\n");
}
