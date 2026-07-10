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

type WorkloadCountDatabase = Pick<typeof dbRead, "select">;

/** Counts live app and agent rows assigned to one Docker node. */
export async function countAllocatedWorkloadsOnNodeWithDatabase(
  database: WorkloadCountDatabase,
  nodeId: string,
): Promise<number> {
  const [[containerRow], [agentRow]] = await Promise.all([
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
          sql`${agentSandboxes.status} not in (${sql.join(
            TERMINAL_SANDBOX_STATUSES.map((status) => sql`${status}`),
            sql`, `,
          )})`,
        ),
      ),
  ]);

  return containerRow.count + agentRow.count;
}
