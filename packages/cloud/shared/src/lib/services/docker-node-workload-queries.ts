/**
 * Counts active Docker-node workloads through an injected database so runtime
 * reconciliation and isolated Postgres integration tests execute the same query.
 */

import { and, eq, sql } from "drizzle-orm";
import type { dbRead } from "../../db/helpers";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { containers } from "../../db/schemas/containers";

/** Sandbox states that no longer consume a live Docker slot. */
export const TERMINAL_SANDBOX_STATUSES = [
  "stopped",
  "error",
  "sleeping",
  "deletion_failed",
] as const;

export const TERMINAL_SANDBOX_STATUS_SET: ReadonlySet<string> = new Set(TERMINAL_SANDBOX_STATUSES);

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

export function holdsCountedNodeSlot(row: { status: string; node_id: string | null }): boolean {
  if (!row.node_id) return false;
  return !TERMINAL_SANDBOX_STATUS_SET.has(row.status);
}

type WorkloadCountDatabase = Pick<typeof dbRead, "select">;

/** Counts live app and agent rows assigned to one Docker node. */
export async function countAllocatedWorkloadsOnNodeWithDatabase(
  database: WorkloadCountDatabase,
  nodeId: string,
): Promise<number> {
  const [[containerRow], [agentRow], [replacementRow]] = await Promise.all([
    database
      .select({ count: sql<number>`count(*)::int` })
      .from(containers)
      .where(
        and(
          eq(containers.node_id, nodeId),
          sql`${containers.status} not in ('failed','stopped','deleted')`,
        ),
      ),
    database
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.node_id, nodeId),
          // Recorded allocation ownership outranks status. Once a deletion
          // generation has handed its slot back the row stops consuming
          // capacity immediately, even though it lingers in `deletion_pending`
          // until the row delete commits; conversely a `deletion_failed` row
          // that still owns its slot genuinely occupies one, which a
          // status-only rule counted as free (#17185).
          //
          // NULL keeps the pre-ownership behaviour byte for byte: rows with no
          // deletion intent never had ownership recorded, and neither did
          // deletion intents that predate the column — both fall through to the
          // terminal-status rule rather than being guessed either way.
          sql`(
            ${agentSandboxes.deletion_allocation_counted} IS TRUE
            OR (
              ${agentSandboxes.deletion_allocation_counted} IS NULL
              AND ${agentSandboxes.status} not in (${sql.join(
                TERMINAL_SANDBOX_STATUSES.map((status) => sql`${status}`),
                sql`, `,
              )})
            )
          )`,
        ),
      ),
    database
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.replacement_cleanup_node_id, nodeId),
          eq(agentSandboxes.replacement_cleanup_allocation_counted, true),
        ),
      ),
  ]);

  return containerRow.count + agentRow.count + replacementRow.count;
}
