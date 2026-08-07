/**
 * Trajectory query — read operations.
 *
 * Handles listing, loading, searching, and filtering trajectories.
 */

import { ElizaError, type IAgentRuntime } from "@elizaos/core";

import {
  asRecord,
  ensureTrajectoriesTable,
  executeRawSql,
  extractRequiredRows,
  hasRuntimeDb,
  parsePersistedTrajectoryRow,
  sqlQuote,
} from "./trajectory-internals.ts";

// ---------------------------------------------------------------------------
// Public read API
// ---------------------------------------------------------------------------

export async function loadPersistedTrajectoryRows(
  runtime: IAgentRuntime,
  maxRows = 5000,
): Promise<Record<string, unknown>[]> {
  if (!hasRuntimeDb(runtime)) {
    throw new ElizaError("Trajectory storage is unavailable", {
      code: "TRAJECTORY_DATABASE_UNAVAILABLE",
    });
  }
  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) {
    throw new ElizaError("Trajectory schema is unavailable", {
      code: "TRAJECTORY_SCHEMA_UNAVAILABLE",
    });
  }

  const safeLimit = Math.max(1, Math.min(10000, Math.trunc(maxRows)));
  const result = await executeRawSql(
    runtime,
    `SELECT * FROM trajectories
     WHERE agent_id = ${sqlQuote(runtime.agentId)}
     ORDER BY created_at DESC LIMIT ${safeLimit}`,
  );
  return extractRequiredRows(result, {
    operation: "load trajectory rows",
    agentId: runtime.agentId,
  }).map((row, index) => {
    const record = asRecord(row);
    if (!record) {
      throw new ElizaError("Trajectory query row is invalid", {
        code: "TRAJECTORY_ROW_INVALID",
        context: { index },
      });
    }
    parsePersistedTrajectoryRow(
      record,
      typeof record.id === "string" ? record.id : "unknown",
    );
    return record;
  });
}
