/**
 * Trajectory steps — read operations.
 *
 * CQRS reader for the agent-owned `trajectory_steps` table. Dedicated rows
 * are canonical when present and retain complete script text.
 */

import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type { PersistedStep } from "./trajectory-internals.ts";
import {
  asRecord,
  executeRawSql,
  extractRequiredRows,
  hasRuntimeDb,
  sqlQuote,
  stepRowToPersistedStep,
} from "./trajectory-internals.ts";

export interface TrajectoryStepsPage {
  steps: PersistedStep[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * Default maximum number of steps to return in a single page. Callers can
 * override with `limit`; values above `MAX_GET_STEPS_LIMIT` are clamped.
 */
export const DEFAULT_GET_STEPS_LIMIT = 100;
export const MAX_GET_STEPS_LIMIT = 1000;

/**
 * Paginated reader for trajectory steps. Returns steps in ordinal order
 * (the order they were appended to the trajectory).
 *
 * Storage and row failures throw; an empty page means the owned trajectory
 * genuinely has no dedicated steps.
 */
export async function getSteps(
  runtime: IAgentRuntime,
  trajectoryId: string,
  offset = 0,
  limit = DEFAULT_GET_STEPS_LIMIT,
): Promise<TrajectoryStepsPage> {
  const normalizedOffset = Math.max(0, Math.trunc(offset));
  const normalizedLimit = Math.max(
    1,
    Math.min(MAX_GET_STEPS_LIMIT, Math.trunc(limit)),
  );
  if (!hasRuntimeDb(runtime)) {
    throw new ElizaError("Trajectory step storage is unavailable", {
      code: "TRAJECTORY_DATABASE_UNAVAILABLE",
    });
  }
  const normalizedId = trajectoryId.trim();
  if (!normalizedId) {
    throw new ElizaError("Trajectory id is required", {
      code: "TRAJECTORY_ID_INVALID",
    });
  }

  const safeId = sqlQuote(normalizedId);
  const countResult = await executeRawSql(
    runtime,
    `SELECT count(*) AS total
     FROM trajectory_steps s
     JOIN trajectories t ON t.id = s.trajectory_id
     WHERE s.trajectory_id = ${safeId}
       AND t.agent_id = ${sqlQuote(runtime.agentId)}`,
  );
  const countRow = asRecord(
    extractRequiredRows(countResult, {
      operation: "count trajectory steps",
      trajectoryId: normalizedId,
    })[0],
  );
  const rawTotal = countRow?.total;
  const total =
    typeof rawTotal === "number"
      ? rawTotal
      : typeof rawTotal === "string" && rawTotal.trim() !== ""
        ? Number(rawTotal)
        : Number.NaN;
  if (!Number.isInteger(total) || total < 0) {
    throw new ElizaError("Trajectory step count row is invalid", {
      code: "TRAJECTORY_STEP_ROW_INVALID",
      context: { trajectoryId: normalizedId, field: "total" },
    });
  }

  if (total === 0) {
    return {
      steps: [],
      total,
      offset: normalizedOffset,
      limit: normalizedLimit,
    };
  }

  const pageResult = await executeRawSql(
    runtime,
    `SELECT s.* FROM trajectory_steps s
       JOIN trajectories t ON t.id = s.trajectory_id
       WHERE s.trajectory_id = ${safeId}
         AND t.agent_id = ${sqlQuote(runtime.agentId)}
       ORDER BY s.ordinal ASC
       LIMIT ${normalizedLimit} OFFSET ${normalizedOffset}`,
  );
  const rows = extractRequiredRows(pageResult, {
    operation: "list trajectory steps",
    trajectoryId: normalizedId,
  });
  const steps = rows.map((row, index) => {
    const record = asRecord(row);
    if (!record) {
      throw new ElizaError("Trajectory step row is invalid", {
        code: "TRAJECTORY_STEP_ROW_INVALID",
        context: { trajectoryId: normalizedId, index },
      });
    }
    return stepRowToPersistedStep(record);
  });

  return {
    steps,
    total,
    offset: normalizedOffset,
    limit: normalizedLimit,
  };
}

/**
 * Load all steps for a trajectory. Used by the existing detail-record path
 * that returns full step lists. Returns the canonical ordinal ordering.
 *
 * For large trajectories prefer `getSteps()` with pagination. This loads up
 * to `MAX_GET_STEPS_LIMIT` steps in a single query.
 */
export async function loadAllStepsForTrajectory(
  runtime: IAgentRuntime,
  trajectoryId: string,
): Promise<PersistedStep[]> {
  const page = await getSteps(runtime, trajectoryId, 0, MAX_GET_STEPS_LIMIT);
  if (page.total <= page.steps.length) return page.steps;

  const all: PersistedStep[] = [...page.steps];
  let offset = page.steps.length;
  while (offset < page.total) {
    const next = await getSteps(
      runtime,
      trajectoryId,
      offset,
      MAX_GET_STEPS_LIMIT,
    );
    if (next.steps.length === 0) break;
    all.push(...next.steps);
    offset += next.steps.length;
  }
  return all;
}
