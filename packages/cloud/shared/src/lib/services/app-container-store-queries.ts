/**
 * Defines app-container reads and slot-accounting transactions independently of
 * the process database singleton so real Postgres tests can inject an isolated DB.
 */

import { and, eq, sql } from "drizzle-orm";
import type { dbWrite } from "../../db/helpers";
import { containers } from "../../db/schemas/containers";
import { dockerNodes } from "../../db/schemas/docker-nodes";

export interface ProjectableContainerRow {
  id: string;
  name: string;
  project_name: string;
  image_tag: string | null;
  port: number;
  organization_id: string;
  user_id: string;
  environment_vars: Record<string, string> | null;
  metadata: Record<string, unknown> | null;
  node_id: string | null;
}

const appContainerSelection = {
  id: containers.id,
  name: containers.name,
  project_name: containers.project_name,
  image_tag: containers.image_tag,
  port: containers.port,
  organization_id: containers.organization_id,
  user_id: containers.user_id,
  environment_vars: containers.environment_vars,
  metadata: containers.metadata,
  node_id: containers.node_id,
};

/** Minimum database surface required by app-container ownership reads. */
export type AppContainerReadDatabase = Pick<typeof dbWrite, "select">;
/** Minimum database surface required by atomic slot mutations. */
export type AppContainerTransactionDatabase = Pick<typeof dbWrite, "transaction">;

/** A slot reservation is either new or an idempotent retry of the same row. */
export type AppContainerNodeSlotClaim = "claimed" | "already-claimed";

export interface ExistingAppContainerNodeSlotClaim {
  nodeId: string | null;
  status: string;
  slotClaimed: boolean;
  slotReleased: boolean;
}

export async function findAppContainerRowById(
  database: AppContainerReadDatabase,
  containerId: string,
): Promise<ProjectableContainerRow | null> {
  const [row] = await database
    .select(appContainerSelection)
    .from(containers)
    .where(eq(containers.id, containerId))
    .limit(1);
  return row ?? null;
}

export function findDeletingAppContainerRows(
  database: AppContainerReadDatabase,
  organizationId: string,
): Promise<ProjectableContainerRow[]> {
  return database
    .select(appContainerSelection)
    .from(containers)
    .where(and(eq(containers.organization_id, organizationId), eq(containers.status, "deleting")));
}

/** Atomically attributes a container to a node and reserves one available slot. */
export function claimAppContainerNodeSlot(
  database: AppContainerTransactionDatabase,
  containerId: string,
  organizationId: string,
  nodeId: string,
  capacityError: () => Error,
  conflictError: (existing: ExistingAppContainerNodeSlotClaim | null) => Error,
): Promise<AppContainerNodeSlotClaim> {
  return database.transaction(async (tx) => {
    const [claimed] = await tx
      .update(containers)
      .set({
        node_id: nodeId,
        metadata: sql`jsonb_set(coalesce(${containers.metadata}, '{}'::jsonb), '{slotClaimedAt}', to_jsonb(now()::text))`,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(containers.id, containerId),
          eq(containers.organization_id, organizationId),
          sql`NOT jsonb_exists(coalesce(${containers.metadata}, '{}'::jsonb), 'slotClaimedAt')`,
          sql`NOT jsonb_exists(coalesce(${containers.metadata}, '{}'::jsonb), 'slotReleasedAt')`,
        ),
      )
      .returning({ id: containers.id });

    if (!claimed) {
      const [existing] = await tx
        .select({
          nodeId: containers.node_id,
          status: containers.status,
          slotClaimed: sql<boolean>`jsonb_exists(coalesce(${containers.metadata}, '{}'::jsonb), 'slotClaimedAt')`,
          slotReleased: sql<boolean>`jsonb_exists(coalesce(${containers.metadata}, '{}'::jsonb), 'slotReleasedAt')`,
        })
        .from(containers)
        .where(and(eq(containers.id, containerId), eq(containers.organization_id, organizationId)))
        .limit(1);
      if (
        existing?.nodeId === nodeId &&
        existing.slotClaimed &&
        !existing.slotReleased &&
        existing.status !== "deleted"
      ) {
        return "already-claimed";
      }
      throw conflictError(existing ?? null);
    }

    const [node] = await tx
      .update(dockerNodes)
      .set({
        allocated_count: sql`${dockerNodes.allocated_count} + 1`,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(dockerNodes.node_id, nodeId),
          eq(dockerNodes.enabled, true),
          sql`${dockerNodes.allocated_count} < ${dockerNodes.capacity}`,
        ),
      )
      .returning({ nodeId: dockerNodes.node_id });

    // The exception rolls back both attribution and the claim marker. The caller
    // supplies its domain error so this SQL-only module stays runtime-independent.
    if (!node) throw capacityError();
    return "claimed";
  });
}

/** Reverses an unstarted container's slot claim without allowing a double decrement. */
export function rollbackAppContainerNodeSlotClaim(
  database: AppContainerTransactionDatabase,
  containerId: string,
  organizationId: string,
  nodeId: string,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const [rolledBack] = await tx
      .update(containers)
      .set({
        node_id: null,
        metadata: sql`coalesce(${containers.metadata}, '{}'::jsonb) - 'slotClaimedAt'`,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(containers.id, containerId),
          eq(containers.organization_id, organizationId),
          eq(containers.node_id, nodeId),
          sql`jsonb_exists(coalesce(${containers.metadata}, '{}'::jsonb), 'slotClaimedAt')`,
          sql`NOT jsonb_exists(coalesce(${containers.metadata}, '{}'::jsonb), 'slotReleasedAt')`,
        ),
      )
      .returning({ id: containers.id });

    if (!rolledBack) return false;
    await tx
      .update(dockerNodes)
      .set({
        allocated_count: sql`GREATEST(${dockerNodes.allocated_count} - 1, 0)`,
        updated_at: new Date(),
      })
      .where(eq(dockerNodes.node_id, nodeId));
    return true;
  });
}
