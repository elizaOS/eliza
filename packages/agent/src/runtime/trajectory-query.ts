/**
 * Trajectory query — read operations.
 *
 * Handles listing, loading, searching, and filtering trajectories.
 */

import type { IAgentRuntime } from "@elizaos/core";

import {
  asRecord,
  ensureTrajectoriesTable,
  executeRawSql,
  extractRows,
  hasRuntimeDb,
} from "./trajectory-internals.ts";

// ---------------------------------------------------------------------------
// Public read API
// ---------------------------------------------------------------------------

export async function loadPersistedTrajectoryRows(
  runtime: IAgentRuntime,
  maxRows = 5000,
): Promise<Record<string, unknown>[] | null> {
  if (!hasRuntimeDb(runtime)) return null;
  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) return [];

  const safeLimit = Math.max(1, Math.min(10000, Math.trunc(maxRows)));
  try {
    const result = await executeRawSql(
      runtime,
      `SELECT * FROM trajectories ORDER BY created_at DESC LIMIT ${safeLimit}`,
    );
    const rows = extractRows(result);
    return rows
      .map((row) => asRecord(row))
      .filter((row): row is Record<string, unknown> => Boolean(row));
  } catch {
    return null;
  }
}
