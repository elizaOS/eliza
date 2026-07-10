/** Maps app deployment requests onto persistent container rows without loading runtime services. */

import type { NewContainer } from "../../db/schemas/containers";
import type { NewAppContainerRow } from "./app-deploy-orchestrator";

/** Preserves app ownership, image, port, and tenant database environment at persistence. */
export function toNewContainer(row: NewAppContainerRow): NewContainer {
  return {
    name: row.containerName,
    // project_name is the durable app identity consumed by delete recovery and
    // the partial per-project uniqueness constraint.
    project_name: row.appId,
    organization_id: row.organizationId,
    user_id: row.userId,
    image_tag: row.image,
    port: row.port,
    // Database credentials belong to the app tenant, never the shared agent DB.
    environment_vars: row.environmentVars,
    metadata: { appId: row.appId },
    status: "pending",
  };
}
