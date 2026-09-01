/**
 * Counts active Docker-node workloads through an injected database so runtime
 * reconciliation and isolated Postgres integration tests execute the same query.
 */

import { and, eq, sql } from "drizzle-orm";
import type { dbRead, dbWrite } from "../../db/helpers";
import {
  type AgentSandboxReplacementAttemptState,
  agentSandboxReplacementAttempts,
} from "../../db/schemas/agent-sandbox-replacement-attempts";
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
 * Exact-restore replacement states whose independently reserved Docker slot has
 * not yet been transferred to the canonical sandbox row or released by proven
 * cleanup.
 */
export const COUNTED_EXACT_RESTORE_REPLACEMENT_STATES = [
  "in_flight_unresolved",
  "cleanup_in_progress",
  "provider_succeeded",
] as const satisfies readonly AgentSandboxReplacementAttemptState[];

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

type WorkloadCountDatabase = Pick<typeof dbRead, "select">;
type WorkloadReconciliationDatabase = Pick<typeof dbWrite, "transaction">;

export interface DockerNodeAllocationRecount {
  before: number;
  after: number;
}

async function exactRestoreReplacementTableExists(
  database: WorkloadCountDatabase,
): Promise<boolean> {
  const [row] = await database
    .select({
      relation: sql<string | null>`to_regclass('public.agent_sandbox_replacement_attempts')::text`,
    })
    // Keep the probe on the same select/from/where surface as the workload
    // counts. A few narrow unit fixtures intentionally implement only that
    // Drizzle subset; they return no `relation` property, which is treated as
    // the historical "table present" assumption. Real PostgreSQL returns NULL
    // when the rolling-deploy relation is absent.
    .from(sql`(VALUES (1)) AS replacement_relation_probe(value)`)
    .where(sql`TRUE`);
  return row?.relation !== null;
}

/** Counts live app and agent rows assigned to one Docker node. */
export async function countAllocatedWorkloadsOnNodeWithDatabase(
  database: WorkloadCountDatabase,
  nodeId: string,
): Promise<number> {
  // Never discover an absent rolling-deploy table by catching 42P01: in
  // PostgreSQL that error aborts the surrounding recount transaction, so the
  // subsequent counter repair cannot run. `to_regclass` is non-throwing and
  // lets us choose a query that does not reference the absent relation.
  const includeExactRestoreReservations = await exactRestoreReplacementTableExists(database);

  // All workload ledgers must share one PostgreSQL statement snapshot. Exact
  // restore atomically transfers one slot from a provider_succeeded attempt to
  // the canonical sandbox row; separate READ COMMITTED SELECTs could observe
  // the sandbox before that commit and the attempt after it, transiently
  // returning zero. Scalar subqueries keep the four categories independent
  // while making their combined observation indivisible, without adding one
  // transaction per node to the placement hot path.
  const commonSelection = {
    containerCount: sql<number>`(
      SELECT count(*)::int
      FROM ${containers}
      WHERE ${containers.node_id} = ${nodeId}
        AND ${containers.status} not in ('failed','stopped','deleted')
    )`,
    agentCount: sql<number>`(
      SELECT count(*)::int
      FROM ${agentSandboxes}
      WHERE ${agentSandboxes.node_id} = ${nodeId}
        AND (
          ${agentSandboxes.deletion_allocation_counted} IS TRUE
          OR (
            ${agentSandboxes.deletion_allocation_counted} IS NULL
            AND ${agentSandboxes.status} not in (${sql.join(
              TERMINAL_SANDBOX_STATUSES.map((status) => sql`${status}`),
              sql`, `,
            )})
          )
        )
    )`,
    replacementCleanupCount: sql<number>`(
      SELECT count(*)::int
      FROM ${agentSandboxes}
      WHERE ${agentSandboxes.replacement_cleanup_node_id} = ${nodeId}
        AND ${agentSandboxes.replacement_cleanup_allocation_counted} IS TRUE
    )`,
  };
  const source = sql`(VALUES (1)) AS workload_count_source(value)`;

  if (!includeExactRestoreReservations) {
    const [row] = await database.select(commonSelection).from(source).where(sql`TRUE`);
    return row.containerCount + row.agentCount + row.replacementCleanupCount;
  }

  const [row] = await database
    .select({
      ...commonSelection,
      exactRestoreReplacementCount: sql<number>`(
        SELECT count(*)::int
        FROM ${agentSandboxReplacementAttempts}
        WHERE ${agentSandboxReplacementAttempts.locator_node_id} = ${nodeId}
          AND ${agentSandboxReplacementAttempts.locator_allocation_counted} IS TRUE
          AND ${agentSandboxReplacementAttempts.restore_attempt_id} IS NOT NULL
          AND ${agentSandboxReplacementAttempts.state} in (${sql.join(
            COUNTED_EXACT_RESTORE_REPLACEMENT_STATES.map((state) => sql`${state}`),
            sql`, `,
          )})
      )`,
    })
    .from(source)
    .where(sql`TRUE`);

  return (
    row.containerCount +
    row.agentCount +
    row.replacementCleanupCount +
    row.exactRestoreReplacementCount
  );
}

/**
 * Atomically repair one node counter from primary workload authority.
 *
 * The node-row lock is deliberately acquired before the count statement.
 * Exact-restore reserve/release writers update this same row in their authority
 * transaction, so such a writer either commits before this recount's READ
 * COMMITTED snapshot or applies its relative +/-1 after the recount commits.
 * The final CAS documents and enforces that no future code can weaken that
 * serialization by dropping the lock.
 */
export async function reconcileAllocatedWorkloadsOnNodeWithDatabase(
  database: WorkloadReconciliationDatabase,
  nodeId: string,
): Promise<DockerNodeAllocationRecount | null> {
  return database.transaction(async (tx) => {
    const [node] = await tx
      .select({
        id: dockerNodes.id,
        allocatedCount: dockerNodes.allocated_count,
      })
      .from(dockerNodes)
      .where(eq(dockerNodes.node_id, nodeId))
      .for("update")
      .limit(1);
    if (!node) return null;

    const authoritativeCount = await countAllocatedWorkloadsOnNodeWithDatabase(tx, nodeId);
    if (authoritativeCount !== node.allocatedCount) {
      const [reconciled] = await tx
        .update(dockerNodes)
        .set({
          allocated_count: authoritativeCount,
          updated_at: new Date(),
        })
        .where(
          and(eq(dockerNodes.id, node.id), eq(dockerNodes.allocated_count, node.allocatedCount)),
        )
        .returning({ id: dockerNodes.id });
      if (!reconciled) {
        throw new Error(`Docker node allocation recount lost its lock/CAS for ${nodeId}`);
      }
    }
    return { before: node.allocatedCount, after: authoritativeCount };
  });
}
