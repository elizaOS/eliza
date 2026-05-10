import type {
  Trajectory,
  TrajectoryLlmCall,
  TrajectoryStep,
} from "@elizaos/agent";
import {
  ELIZA_NATIVE_TRAJECTORY_FORMAT,
  iterateTrajectoryLlmCalls,
  type ElizaNativeTrajectoryRow,
} from "@elizaos/core";

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

function isElizaNativeExportRow(value: unknown): value is ElizaNativeTrajectoryRow {
  return (
    isRecord(value) &&
    value.format === ELIZA_NATIVE_TRAJECTORY_FORMAT &&
    isRecord(value.request) &&
    isRecord(value.response)
  );
}

export function parseTrajectoryExportText(payload: string): unknown[] {
  const trimmed = payload.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  }

  if (trimmed.startsWith("{")) {
    try {
      return [JSON.parse(trimmed) as unknown];
    } catch {
      if (!trimmed.includes("\n")) {
        return [];
      }
    }
  }

  if (trimmed.includes("\n")) {
    return trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  }

  return [];
}

export function extractElizaNativeRowsFromExportText(
  payload: string,
): ElizaNativeTrajectoryRow[] {
  return parseTrajectoryExportText(payload).filter(isElizaNativeExportRow);
}

export function listTrajectoryCallEntries(
  trajectory: Trajectory,
): TrajectoryCallEntry[] {
  const trajectoryId = String(trajectory.trajectoryId);
  const steps = trajectory.steps ?? [];

  return iterateTrajectoryLlmCalls(trajectory).map((call) => {
    const step =
      steps[call.stepIndex] ??
      ({
        stepId: call.stepId,
        timestamp: call.stepTimestamp,
        llmCalls: [],
        providerAccesses: [],
      } satisfies TrajectoryStep);

    return {
      trajectory,
      trajectoryId,
      step,
      stepId: call.stepId,
      stepIndex: call.stepIndex,
      call: call as TrajectoryLlmCall,
      callIndex: call.callIndex,
    };
  });
}
