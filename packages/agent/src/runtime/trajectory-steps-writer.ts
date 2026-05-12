/**
 * Trajectory steps — write operations.
 *
 * CQRS writer for the dedicated `trajectory_steps` table. Writers return
 * `void` on success; failures throw or are swallowed by the caller's
 * write-queue.
 *
 * Scripts are stored in a dedicated `script` TEXT column with no character
 * cap (the legacy `TRAJECTORY_STEP_SCRIPT_MAX_CHARS=4096` cap applied only
 * to inline JSON storage).
 */

import type { IAgentRuntime } from "@elizaos/core";

import {
  executeRawSql,
  hasRuntimeDb,
  type PersistedStep,
  sqlNumber,
  sqlQuote,
} from "./trajectory-internals.ts";

function serializeStepPayload(step: PersistedStep): string {
  // Strip `script` from payload because it gets a dedicated column.
  const { script: _script, ...rest } = step;
  return JSON.stringify(rest);
}

function resolveStepType(step: PersistedStep): string {
  if (step.kind === "llm" || step.kind === "action") return step.kind;
  // Legacy rows defaulted to "llm" semantics.
  return "llm";
}

function resolveStepName(step: PersistedStep): string | null {
  // Use the first llm-call purpose or provider-access name as a display label.
  const firstCall = step.llmCalls[0];
  if (firstCall?.purpose) return firstCall.purpose;
  const firstProvider = step.providerAccesses[0];
  if (firstProvider?.providerName) return firstProvider.providerName;
  return null;
}

/**
 * Upsert a single step row. Idempotent on `id` (== step.stepId).
 */
export async function upsertStep(
  runtime: IAgentRuntime,
  trajectoryId: string,
  step: PersistedStep,
  parentStepId: string | null = null,
): Promise<void> {
  if (!hasRuntimeDb(runtime)) return;
  const stepType = resolveStepType(step);
  const name = resolveStepName(step);
  const startedAt = Number.isFinite(step.timestamp) ? step.timestamp : null;
  const endedAt = startedAt; // The legacy step shape only carried a single timestamp.
  const payload = serializeStepPayload(step);
  const script = typeof step.script === "string" ? step.script : null;

  const sql = `INSERT INTO trajectory_steps (
      id,
      trajectory_id,
      ordinal,
      parent_step_id,
      step_type,
      name,
      started_at,
      ended_at,
      payload,
      script
    ) VALUES (
      ${sqlQuote(step.stepId)},
      ${sqlQuote(trajectoryId)},
      ${sqlNumber(step.stepNumber)},
      ${parentStepId ? sqlQuote(parentStepId) : "NULL"},
      ${sqlQuote(stepType)},
      ${name ? sqlQuote(name) : "NULL"},
      ${sqlNumber(startedAt)},
      ${sqlNumber(endedAt)},
      ${sqlQuote(payload)},
      ${script !== null ? sqlQuote(script) : "NULL"}
    )
    ON CONFLICT (id) DO UPDATE SET
      trajectory_id = EXCLUDED.trajectory_id,
      ordinal = EXCLUDED.ordinal,
      parent_step_id = EXCLUDED.parent_step_id,
      step_type = EXCLUDED.step_type,
      name = EXCLUDED.name,
      started_at = EXCLUDED.started_at,
      ended_at = EXCLUDED.ended_at,
      payload = EXCLUDED.payload,
      script = EXCLUDED.script`;

  await executeRawSql(runtime, sql);
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
  if (!hasRuntimeDb(runtime)) return;
  const safeId = sqlQuote(trajectoryId);
  await executeRawSql(
    runtime,
    `DELETE FROM trajectory_steps WHERE trajectory_id = ${safeId}`,
  );
  for (const step of steps) {
    await upsertStep(runtime, trajectoryId, step, null);
  }
}

/**
 * Delete all step rows for the given trajectory IDs. Returns the number
 * of rows deleted, or `null` if the operation could not be performed.
 */
export async function deleteStepsForTrajectories(
  runtime: IAgentRuntime,
  trajectoryIds: string[],
): Promise<number | null> {
  if (!hasRuntimeDb(runtime)) return null;
  const normalized = trajectoryIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (normalized.length === 0) return 0;

  const values = normalized.map((id) => sqlQuote(id)).join(", ");
  const result = await executeRawSql(
    runtime,
    `DELETE FROM trajectory_steps WHERE trajectory_id IN (${values}) RETURNING trajectory_id`,
  );
  // The result row count is an estimate; we don't strictly need it for
  // correctness, callers use `deletePersistedTrajectoryRows` for the
  // authoritative count.
  if (Array.isArray(result)) return result.length;
  return normalized.length;
}

/**
 * Delete all step rows. Returns null if the operation failed.
 */
export async function clearAllSteps(
  runtime: IAgentRuntime,
): Promise<number | null> {
  if (!hasRuntimeDb(runtime)) return null;
  await executeRawSql(runtime, "DELETE FROM trajectory_steps");
  return 0;
}
