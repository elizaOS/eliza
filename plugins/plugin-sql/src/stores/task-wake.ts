/** Single-statement, agent-scoped callers own task wake request/consumption.
 * Ordinary whole metadata replacement preserves these scheduler-owned keys. */
import { ElizaError, type TaskMetadataPatch } from "@elizaos/core";
import { type SQL, sql } from "drizzle-orm";

export function preserveTaskWake(stored: SQL, replacement: unknown): SQL {
  return sql`((${JSON.stringify(replacement)}::jsonb - 'wakeAt' - 'wakeRevision') || (jsonb_strip_nulls(jsonb_build_object('wakeAt', ${stored}->'wakeAt', 'wakeRevision', ${stored}->'wakeRevision'))))`;
}
export function applyTaskWakePatch(
  stored: SQL,
  merged: SQL,
  wake: NonNullable<TaskMetadataPatch["wake"]>
): SQL {
  for (const value of [wake.requestAt, wake.consumeRevision])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new ElizaError("Task wake requires nonnegative safe integer milliseconds/revision", {
        code: "TASK_WAKE_INVALID",
      });
  if (wake.requestAt === undefined && wake.consumeRevision === undefined)
    throw new ElizaError("Empty task wake operation", { code: "TASK_WAKE_INVALID" });
  const revision = sql`COALESCE((${stored}->>'wakeRevision')::bigint, 0)`;
  const validRevision = sql`CASE WHEN (NOT (${stored} ? 'wakeRevision') OR (jsonb_typeof(${stored}->'wakeRevision') = 'number' AND (${stored}->>'wakeRevision')::numeric = trunc((${stored}->>'wakeRevision')::numeric))) AND ${revision} BETWEEN 0 AND ${wake.requestAt === undefined ? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER - 1} THEN ${revision} ELSE (${revision}::text || ' invalid task wake revision')::bigint END`;
  const previous = sql`(${stored}->>'wakeAt')::bigint`;
  const validAt = sql`CASE WHEN NOT (${stored} ? 'wakeAt') OR (jsonb_typeof(${stored}->'wakeAt') = 'number' AND (${stored}->>'wakeAt')::numeric = trunc((${stored}->>'wakeAt')::numeric) AND ${previous} BETWEEN 0 AND 9007199254740991) THEN ${previous} ELSE (${previous}::text || ' invalid task wake time')::bigint END`;
  const retained =
    wake.consumeRevision === undefined
      ? validAt
      : sql`CASE WHEN ${validRevision} = ${wake.consumeRevision} THEN NULL ELSE ${validAt} END`;
  const deadline =
    wake.requestAt === undefined ? retained : sql`LEAST(${retained}, ${wake.requestAt}::bigint)`;
  const nextRevision = wake.requestAt === undefined ? validRevision : sql`(${validRevision} + 1)`;
  return sql`CASE WHEN (${stored} ? 'wakeAt') AND NOT (jsonb_typeof(${stored}->'wakeAt') = 'number' AND (${stored}->>'wakeAt')::numeric = trunc((${stored}->>'wakeAt')::numeric) AND (${stored}->>'wakeAt')::numeric BETWEEN 0 AND 9007199254740991) THEN (('invalid task wake metadata' || substr(${stored}::text,1,0))::bigint)::text::jsonb ELSE ((${merged} - 'wakeAt' - 'wakeRevision') || jsonb_build_object('wakeRevision', ${nextRevision}) || CASE WHEN ${deadline} IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('wakeAt', ${deadline}) END) END`;
}

export function assertNoAuthoredTaskWake(metadata: unknown): void {
  if (
    metadata &&
    typeof metadata === "object" &&
    (Object.hasOwn(metadata, "wakeAt") || Object.hasOwn(metadata, "wakeRevision"))
  )
    throw new ElizaError("Task wake keys require atomic wake operation", {
      code: "TASK_WAKE_INVALID",
    });
}
