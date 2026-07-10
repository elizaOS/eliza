/**
 * Defines the app-container row projection and ownership-scoped reads independently
 * of the process database singleton so real Postgres tests can inject an isolated DB.
 */

import { and, eq, inArray, ne } from "drizzle-orm";
import type { dbWrite } from "../../db/helpers";
import { containers } from "../../db/schemas/containers";

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
};

type AppContainerReadDatabase = Pick<typeof dbWrite, "select">;

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

/**
 * `containers.status` values in which a row still expects its docker container
 * to be alive. `deleting` is deliberately excluded: such a row wants its
 * container gone, so a sibling delete removing the shared name completes — not
 * conflicts with — its teardown. `stopped`/`failed`/`deleted` are terminal (the
 * orphan reconciler's reapable set).
 */
const CONTAINER_EXPECTING_STATUSES = ["pending", "building", "deploying", "running"];

/**
 * Ids of rows other than `excludeContainerId` that still expect a live
 * container named `containerName` — the delete executor's name-collision guard
 * (#15826). A non-empty result means a name-based `docker rm -f` would hit a
 * live deploy's container. Deliberately NOT org-scoped: no row anywhere may
 * lose its container to someone else's delete.
 */
export async function findActiveContainerIdsSharingName(
  database: AppContainerReadDatabase,
  containerName: string,
  excludeContainerId: string,
): Promise<string[]> {
  const rows = await database
    .select({ id: containers.id })
    .from(containers)
    .where(
      and(
        eq(containers.name, containerName),
        ne(containers.id, excludeContainerId),
        inArray(containers.status, CONTAINER_EXPECTING_STATUSES),
      ),
    );
  return rows.map((row) => row.id);
}
