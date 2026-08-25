/**
 * Counts active Docker-node workloads through an injected database so runtime
 * reconciliation and isolated Postgres integration tests execute the same query.
 */

import { sql } from "drizzle-orm";
import type { dbRead } from "../../db/helpers";
import { agentBackupRestoreOperations } from "../../db/schemas/agent-backup-catalog";
import { agentSandboxReplacementAttempts } from "../../db/schemas/agent-sandbox-replacement-attempts";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { containers } from "../../db/schemas/containers";
import { dockerNodes } from "../../db/schemas/docker-nodes";

/** Sandbox states that no longer consume a live Docker slot. */
export const TERMINAL_SANDBOX_STATUSES = [
  "stopped",
  "error",
  "sleeping",
  "deletion_failed",
] as const;

export const TERMINAL_SANDBOX_STATUS_SET: ReadonlySet<string> = new Set(TERMINAL_SANDBOX_STATUSES);

/**
 * Whether a row is ALREADY inside a deletion generation, so a new delete request
 * continues it rather than establishing a fresh one.
 *
 * Deliberately broader than `deletion_started_at !== null`. Nothing ties the
 * intent columns to `status`, so a row can sit in `deletion_pending` with both
 * intent columns NULL — the shape the #17249 incident left behind, and the shape
 * of any row that entered `deletion_pending` before those columns existed. Under
 * the narrow test such a row reads as "fresh", and ownership gets re-derived from
 * its own `deletion_pending` status, which `holdsCountedNodeSlot` scores as still
 * counted. That arms a release for a slot the pre-ownership provider already
 * decremented, and the next teardown frees a live sibling's slot — the exact
 * double-free `deletion_allocation_counted` exists to prevent (#17185).
 *
 * Both deletion-intent writers must use this; they disagreed once and that
 * disagreement was the defect.
 */
export function isDeletionContinuation(row: {
  status: string;
  deletion_attempt_id: string | null;
  deletion_started_at: Date | string | null;
}): boolean {
  return (
    Boolean(row.deletion_attempt_id) ||
    row.deletion_started_at !== null ||
    row.status === "deletion_pending" ||
    row.status === "deletion_failed"
  );
}

/**
 * Whether a row still holds one counted slot in `docker_nodes.allocated_count`.
 *
 * Seeds `agent_sandboxes.deletion_allocation_counted` when a deletion generation
 * starts, so it must be evaluated against the PRE-delete lifecycle state, before
 * the row moves to `deletion_pending`.
 *
 * Derived from `TERMINAL_SANDBOX_STATUSES` rather than listing statuses again,
 * because the two rules must not drift: `syncAllocatedCounts` periodically
 * RECOMPUTES `allocated_count` from that same set, so any status this treated as
 * still-counted while the recount treated it as free would be released twice —
 * once by the recount, once by the deletion CAS — which is the exact double-free
 * #17185 exists to close. A row with no `node_id` was never placed at all.
 */
export function holdsCountedNodeSlot(row: { status: string; node_id: string | null }): boolean {
  if (!row.node_id) return false;
  return !TERMINAL_SANDBOX_STATUS_SET.has(row.status);
}

type WorkloadCountDatabase = Pick<typeof dbRead, "execute">;

/**
 * Counts every live or reserved slot in one database snapshot.
 *
 * A restore->replacement->sandbox handoff changes two authorities in one
 * transaction. Separate SELECTs under READ COMMITTED could observe opposite
 * sides of that commit and derive either zero or two owners. Scalar subqueries
 * inside this single statement all share one snapshot, so each atomic handoff
 * contributes exactly one slot. Reserved owners join the immutable node-record
 * id as well as logical node id, but deliberately remain counted across an
 * incarnation change: reboot invalidates the remote target, not the retained
 * slot, and cleanup must settle that authority before capacity is reusable.
 * App-container slot markers outrank lifecycle status: a durable claim remains
 * counted until its durable release, while rows created before those markers
 * retain the historical status fallback.
 */
export async function countAllocatedWorkloadsOnNodeWithDatabase(
  database: WorkloadCountDatabase,
  nodeId: string,
): Promise<number> {
  const result = await database.execute<{ count: number | string }>(sql`
    SELECT (
      (SELECT count(*) FROM ${containers}
        WHERE ${containers.node_id} = ${nodeId}
          AND NOT jsonb_exists(
            COALESCE(${containers.metadata}, '{}'::jsonb), 'slotReleasedAt'
          )
          AND (
            jsonb_exists(COALESCE(${containers.metadata}, '{}'::jsonb), 'slotClaimedAt')
            OR ${containers.status} NOT IN ('failed', 'stopped', 'deleted')
          ))
      + (SELECT count(*) FROM ${agentSandboxes}
        WHERE ${agentSandboxes.node_id} = ${nodeId}
          AND (
            ${agentSandboxes.deletion_allocation_counted} IS TRUE
            OR (
              ${agentSandboxes.deletion_allocation_counted} IS NULL
              AND ${agentSandboxes.status} NOT IN (${sql.join(
                TERMINAL_SANDBOX_STATUSES.map((status) => sql`${status}`),
                sql`, `,
              )})
            )
          ))
      + (SELECT count(*) FROM ${agentSandboxes} AS cleanup
        WHERE cleanup."replacement_cleanup_allocation_counted" IS TRUE
          AND (
            (cleanup."replacement_cleanup_node_record_id" IS NULL
              AND cleanup."replacement_cleanup_node_id" = ${nodeId})
            OR (cleanup."replacement_cleanup_node_record_id" IS NOT NULL AND EXISTS (
              SELECT 1 FROM ${dockerNodes} AS cleanup_node
              WHERE cleanup_node."id" = cleanup."replacement_cleanup_node_record_id"
                AND cleanup_node."node_id" = ${nodeId}
            ))
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ${agentSandboxReplacementAttempts} AS reserved_attempt
            WHERE reserved_attempt."capacity_state" = 'reserved'
              AND reserved_attempt."id"
                = cleanup."replacement_cleanup_attempt_id"
              AND reserved_attempt."organization_id" = cleanup."organization_id"
              AND reserved_attempt."agent_id" = cleanup."id"
              AND reserved_attempt."locator_sandbox_id"
                = cleanup."replacement_cleanup_sandbox_id"
              AND reserved_attempt."locator_node_id"
                = cleanup."replacement_cleanup_node_id"
              AND reserved_attempt."locator_node_record_id"
                = cleanup."replacement_cleanup_node_record_id"
              AND reserved_attempt."locator_node_incarnation"
                = cleanup."replacement_cleanup_node_incarnation"
              AND reserved_attempt."locator_node_history_id"
                = cleanup."replacement_cleanup_node_history_id"
              AND reserved_attempt."locator_container_name"
                = cleanup."replacement_cleanup_container_name"
          ))
      + (SELECT count(*)
        FROM ${agentBackupRestoreOperations}
        INNER JOIN ${dockerNodes}
          ON ${dockerNodes.id} = ${agentBackupRestoreOperations.expected_node_record_id}
        WHERE ${dockerNodes.node_id} = ${nodeId}
          AND ${agentBackupRestoreOperations.capacity_state} = 'reserved')
      + (SELECT count(*)
        FROM ${agentSandboxReplacementAttempts}
        INNER JOIN ${dockerNodes}
          ON ${dockerNodes.id} = ${agentSandboxReplacementAttempts.locator_node_record_id}
        WHERE ${dockerNodes.node_id} = ${nodeId}
          AND ${agentSandboxReplacementAttempts.capacity_state} = 'reserved')
    )::int AS count
  `);
  const row = result.rows[0];
  const count = Number(row?.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Docker-node workload count query returned an invalid aggregate");
  }
  return count;
}

/**
 * Counts live, retained, and reserved owners that make a node unsafe to drain.
 * Durable app and agent slot ownership outranks a terminal lifecycle status:
 * drain must not destroy a node until the corresponding release is recorded.
 * Any app container with volume_path set pins its host regardless of lifecycle
 * status. This is the autoscaler contract even when external-volume metadata is
 * also present.
 */
export async function countRetainedWorkloadsOnNodeWithDatabase(
  database: WorkloadCountDatabase,
  nodeId: string,
): Promise<number> {
  const result = await database.execute<{ count: number | string }>(sql`
    SELECT (
      (SELECT count(*) FROM ${containers}
        WHERE ${containers.node_id} = ${nodeId}
          AND (
            ${containers.status} NOT IN ('failed', 'deleted')
            OR ${containers.volume_path} IS NOT NULL
            OR (
              NOT jsonb_exists(
                COALESCE(${containers.metadata}, '{}'::jsonb), 'slotReleasedAt'
              )
              AND jsonb_exists(
                COALESCE(${containers.metadata}, '{}'::jsonb), 'slotClaimedAt'
              )
            )
          ))
      + (SELECT count(*) FROM ${agentSandboxes}
        WHERE ${agentSandboxes.node_id} = ${nodeId}
          AND (
            ${agentSandboxes.deletion_allocation_counted} IS TRUE
            OR (
              ${agentSandboxes.status} NOT IN ('stopped', 'error')
              AND (${agentSandboxes.pool_status} IS NULL
                OR ${agentSandboxes.pool_status} <> 'unclaimed')
            )
          ))
      + (SELECT count(*) FROM ${agentSandboxes} AS cleanup
        WHERE (
            (cleanup."replacement_cleanup_node_record_id" IS NULL
              AND cleanup."replacement_cleanup_node_id" = ${nodeId})
            OR (cleanup."replacement_cleanup_node_record_id" IS NOT NULL AND EXISTS (
              SELECT 1 FROM ${dockerNodes} AS cleanup_node
              WHERE cleanup_node."id" = cleanup."replacement_cleanup_node_record_id"
                AND cleanup_node."node_id" = ${nodeId}
            ))
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ${agentSandboxReplacementAttempts} AS reserved_attempt
            WHERE reserved_attempt."capacity_state" = 'reserved'
              AND reserved_attempt."id"
                = cleanup."replacement_cleanup_attempt_id"
              AND reserved_attempt."organization_id" = cleanup."organization_id"
              AND reserved_attempt."agent_id" = cleanup."id"
              AND reserved_attempt."locator_sandbox_id"
                = cleanup."replacement_cleanup_sandbox_id"
              AND reserved_attempt."locator_node_id"
                = cleanup."replacement_cleanup_node_id"
              AND reserved_attempt."locator_node_record_id"
                = cleanup."replacement_cleanup_node_record_id"
              AND reserved_attempt."locator_node_incarnation"
                = cleanup."replacement_cleanup_node_incarnation"
              AND reserved_attempt."locator_node_history_id"
                = cleanup."replacement_cleanup_node_history_id"
              AND reserved_attempt."locator_container_name"
                = cleanup."replacement_cleanup_container_name"
          ))
      + (SELECT count(*)
        FROM ${agentBackupRestoreOperations}
        INNER JOIN ${dockerNodes}
          ON ${dockerNodes.id} = ${agentBackupRestoreOperations.expected_node_record_id}
        WHERE ${dockerNodes.node_id} = ${nodeId}
          AND ${agentBackupRestoreOperations.capacity_state} = 'reserved')
      + (SELECT count(*)
        FROM ${agentSandboxReplacementAttempts}
        INNER JOIN ${dockerNodes}
          ON ${dockerNodes.id} = ${agentSandboxReplacementAttempts.locator_node_record_id}
        WHERE ${dockerNodes.node_id} = ${nodeId}
          AND ${agentSandboxReplacementAttempts.capacity_state} = 'reserved')
    )::int AS count
  `);
  const row = result.rows[0];
  const count = Number(row?.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Docker-node retained workload query returned an invalid aggregate");
  }
  return count;
}
