/**
 * Retention purge for recorded model calls (`llm_trajectories`).
 *
 * Deletes rows older than `LLM_TRAJECTORY_RETENTION_DAYS` (default 90) and
 * their payload objects. Objects are deleted before their rows so a failure
 * never leaves an unreferenced payload behind; a failed object delete stops
 * the run and the row is retried on the next one.
 */

import { and, asc, inArray, lt } from "drizzle-orm";
import { dbWrite } from "../../db/client";
import { llmTrajectories } from "../../db/schemas/llm-trajectories";
import { resolveTrajectoryRetentionDays } from "../config/llm-trajectory-policy";
import { logger } from "../utils/logger";
import { deleteTrajectoryPayload } from "./trajectory-object-storage";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows handled per database round trip. */
const PURGE_BATCH_SIZE = 500;
/** Batches per cron run; the next run continues where this one stopped. */
const PURGE_MAX_BATCHES = 40;

export interface LlmTrajectoryPurgeResult {
  retentionDays: number;
  cutoff: string;
  deletedRows: number;
  deletedObjects: number;
  /** True when the per-run batch budget ran out before the backlog emptied. */
  more: boolean;
}

export async function purgeExpiredLlmTrajectories(
  options: { now?: Date; retentionDays?: number } = {},
): Promise<LlmTrajectoryPurgeResult> {
  const retentionDays = options.retentionDays ?? resolveTrajectoryRetentionDays();
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);

  let deletedRows = 0;
  let deletedObjects = 0;
  let more = false;

  for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
    const rows = await dbWrite
      .select({
        id: llmTrajectories.id,
        storage: llmTrajectories.trajectory_payload_storage,
        key: llmTrajectories.trajectory_payload_key,
      })
      .from(llmTrajectories)
      .where(lt(llmTrajectories.created_at, cutoff))
      .orderBy(asc(llmTrajectories.created_at))
      .limit(PURGE_BATCH_SIZE);
    if (rows.length === 0) break;

    for (const row of rows) {
      if (!row.key) continue;
      if (row.storage === "private_object" || row.storage === "r2") {
        await deleteTrajectoryPayload(row.storage, row.key);
        deletedObjects += 1;
      }
    }

    const removed = await dbWrite
      .delete(llmTrajectories)
      .where(
        and(
          inArray(
            llmTrajectories.id,
            rows.map((row) => row.id),
          ),
          lt(llmTrajectories.created_at, cutoff),
        ),
      )
      .returning({ id: llmTrajectories.id });
    deletedRows += removed.length;

    if (rows.length < PURGE_BATCH_SIZE) break;
    if (batch === PURGE_MAX_BATCHES - 1) more = true;
  }

  const result: LlmTrajectoryPurgeResult = {
    retentionDays,
    cutoff: cutoff.toISOString(),
    deletedRows,
    deletedObjects,
    more,
  };
  logger.info("[LlmTrajectoryPurge] purged expired trajectories", { ...result });
  return result;
}
