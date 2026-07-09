/**
 * Defines the app-container row projection and ownership-scoped reads independently
 * of the process database singleton so real Postgres tests can inject an isolated DB.
 */

import { and, eq } from "drizzle-orm";
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
