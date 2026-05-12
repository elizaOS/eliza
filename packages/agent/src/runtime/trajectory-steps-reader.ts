/**
 * Trajectory steps — read operations.
 *
 * CQRS reader for the dedicated `trajectory_steps` table. Returns plain
 * domain `PersistedStep` records, never mutates state.
 *
 * The `trajectory_steps` table replaces the JSONB blob previously stored in
 * `trajectories.steps_json`. Scripts are no longer capped at 4096 chars.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { PersistedStep } from "./trajectory-internals.ts";
import {
  asRecord,
  executeRawSql,
  extractRows,
  hasRuntimeDb,
  parseJsonValue,
  readRecordValue,
  sqlQuote,
  toNumber,
  toOptionalNumber,
  toText,
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

function rowToPersistedStep(row: Record<string, unknown>): PersistedStep {
  const payload = parseJsonValue(readRecordValue(row, ["payload"]));
  const payloadRecord = asRecord(payload) ?? {};
  const llmCalls = Array.isArray(payloadRecord.llmCalls)
    ? (payloadRecord.llmCalls as PersistedStep["llmCalls"])
    : [];
  const providerAccesses = Array.isArray(payloadRecord.providerAccesses)
    ? (payloadRecord.providerAccesses as PersistedStep["providerAccesses"])
    : [];
  const childSteps = Array.isArray(payloadRecord.childSteps)
    ? (payloadRecord.childSteps as string[])
    : undefined;
  const usedSkills = Array.isArray(payloadRecord.usedSkills)
    ? (payloadRecord.usedSkills as string[])
    : undefined;

  const stepNumber = toNumber(readRecordValue(row, ["ordinal"]), 0);
  const startedAt = toOptionalNumber(readRecordValue(row, ["started_at"]));
  const endedAt = toOptionalNumber(readRecordValue(row, ["ended_at"]));
  const kindRaw = toText(readRecordValue(row, ["step_type"]), "");
  const kind = kindRaw === "llm" || kindRaw === "action" ? kindRaw : undefined;
  const scriptValue = readRecordValue(row, ["script"]);
  const script =
    typeof scriptValue === "string" && scriptValue.length > 0
      ? scriptValue
      : undefined;
  const scriptHash =
    typeof payloadRecord.scriptHash === "string"
      ? (payloadRecord.scriptHash as string)
      : undefined;

  return {
    stepId: toText(readRecordValue(row, ["id"]), ""),
    stepNumber,
    timestamp: startedAt ?? endedAt ?? Date.now(),
    llmCalls,
    providerAccesses,
    ...(kind !== undefined ? { kind } : {}),
    ...(childSteps !== undefined ? { childSteps } : {}),
    ...(script !== undefined ? { script } : {}),
    ...(scriptHash !== undefined ? { scriptHash } : {}),
    ...(usedSkills !== undefined ? { usedSkills } : {}),
  };
}

/**
 * Paginated reader for trajectory steps. Returns steps in ordinal order
 * (the order they were appended to the trajectory).
 *
 * Returns an empty page when the runtime has no database or the table
 * does not exist. The caller is responsible for ensuring the table is
 * created (via `ensureTrajectoriesTable`) before calling.
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
  const empty: TrajectoryStepsPage = {
    steps: [],
    total: 0,
    offset: normalizedOffset,
    limit: normalizedLimit,
  };
  if (!hasRuntimeDb(runtime)) return empty;
  const normalizedId = trajectoryId.trim();
  if (!normalizedId) return empty;

  const safeId = sqlQuote(normalizedId);
  const countResult = await executeRawSql(
    runtime,
    `SELECT count(*) AS total FROM trajectory_steps WHERE trajectory_id = ${safeId}`,
  );
  const countRow = asRecord(extractRows(countResult)[0]);
  const total = toNumber(countRow?.total, 0);

  if (total === 0) return empty;

  const pageResult = await executeRawSql(
    runtime,
    `SELECT * FROM trajectory_steps
       WHERE trajectory_id = ${safeId}
       ORDER BY ordinal ASC
       LIMIT ${normalizedLimit} OFFSET ${normalizedOffset}`,
  );
  const rows = extractRows(pageResult);
  const steps = rows
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .map(rowToPersistedStep);

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
