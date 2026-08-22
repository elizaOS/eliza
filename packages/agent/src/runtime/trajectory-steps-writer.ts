/**
 * Trajectory steps — write operations.
 *
 * CQRS writer for the dedicated `trajectory_steps` table. Successful writes
 * return their real result; invalid ownership and unavailable storage throw.
 *
 * Scripts are stored completely in the dedicated `script` TEXT column.
 */

import { ElizaError, type IAgentRuntime } from "@elizaos/core";

import {
  executeRawSqlTransaction,
  extractRequiredRows,
  hasRuntimeDb,
  loadTrajectoryById,
  type PersistedStep,
  saveTrajectory,
  sqlQuote,
} from "./trajectory-internals.ts";

/**
 * Upsert a single step row. Identity is immutable across trajectories.
 */
export async function upsertStep(
  runtime: IAgentRuntime,
  trajectoryId: string,
  step: PersistedStep,
  parentStepId?: string | null,
): Promise<void> {
  if (!hasRuntimeDb(runtime)) {
    throw new ElizaError("Trajectory step storage is unavailable", {
      code: "TRAJECTORY_DATABASE_UNAVAILABLE",
    });
  }
  const trajectory = await loadTrajectoryById(runtime, trajectoryId);
  if (!trajectory) {
    throw new ElizaError("Trajectory parent is unavailable", {
      code: "TRAJECTORY_PARENT_NOT_FOUND",
      context: { trajectoryId, stepId: step.stepId },
    });
  }
  const normalizedStep: PersistedStep = {
    ...step,
    ...(parentStepId !== undefined
      ? { parentStepId: parentStepId ?? undefined }
      : {}),
  };
  const existingIndex = trajectory.steps.findIndex(
    (candidate) => candidate.stepId === step.stepId,
  );
  if (existingIndex >= 0) trajectory.steps[existingIndex] = normalizedStep;
  else trajectory.steps.push(normalizedStep);
  trajectory.updatedAt = new Date().toISOString();
  await saveTrajectory(runtime, trajectory, {
    changedStepIds: [step.stepId],
    updateLegacySnapshot: true,
  });
}

/**
 * Replace the full step set for a trajectory in a single batch.
 *
 * Deletes existing rows for the trajectory, then inserts the provided
 * steps. Used by the storage layer to keep the dedicated table in sync
 * with the canonical in-memory step list.
 */
export async function replaceStepsForTrajectory(
  runtime: IAgentRuntime,
  trajectoryId: string,
  steps: PersistedStep[],
): Promise<void> {
  if (!hasRuntimeDb(runtime)) {
    throw new ElizaError("Trajectory step storage is unavailable", {
      code: "TRAJECTORY_DATABASE_UNAVAILABLE",
    });
  }
  const trajectory = await loadTrajectoryById(runtime, trajectoryId);
  if (!trajectory) {
    throw new ElizaError("Trajectory parent is unavailable", {
      code: "TRAJECTORY_PARENT_NOT_FOUND",
      context: { trajectoryId },
    });
  }
  trajectory.steps = [...steps].sort(
    (left, right) => left.stepNumber - right.stepNumber,
  );
  trajectory.updatedAt = new Date().toISOString();
  await saveTrajectory(runtime, trajectory);
}

/**
 * Delete owned step rows for the given trajectory IDs and return the real count.
 */
export async function deleteStepsForTrajectories(
  runtime: IAgentRuntime,
  trajectoryIds: string[],
): Promise<number> {
  if (!hasRuntimeDb(runtime)) {
    throw new ElizaError("Trajectory step storage is unavailable", {
      code: "TRAJECTORY_DATABASE_UNAVAILABLE",
    });
  }
  const normalized = trajectoryIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (normalized.length === 0) return 0;

  const values = normalized.map((id) => sqlQuote(id)).join(", ");
  return executeRawSqlTransaction(runtime, async (execute) => {
    const result = await execute(
      `DELETE FROM trajectory_steps WHERE trajectory_id IN (
         SELECT id FROM trajectories
         WHERE agent_id = ${sqlQuote(runtime.agentId)} AND id IN (${values})
       ) RETURNING trajectory_id`,
    );
    return extractRequiredRows(result, {
      operation: "delete trajectory steps",
    }).length;
  });
}

/**
 * Delete all step rows owned by the current runtime agent.
 */
export async function clearAllSteps(runtime: IAgentRuntime): Promise<number> {
  if (!hasRuntimeDb(runtime)) {
    throw new ElizaError("Trajectory step storage is unavailable", {
      code: "TRAJECTORY_DATABASE_UNAVAILABLE",
    });
  }
  return executeRawSqlTransaction(runtime, async (execute) => {
    const result = await execute(
      `DELETE FROM trajectory_steps WHERE trajectory_id IN (
         SELECT id FROM trajectories WHERE agent_id = ${sqlQuote(runtime.agentId)}
       ) RETURNING trajectory_id`,
    );
    return extractRequiredRows(result, {
      operation: "clear trajectory steps",
    }).length;
  });
}
