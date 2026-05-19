/**
 * Pure helpers + types for the app-deployments service.
 *
 * Lives in a separate module so unit tests can import these helpers without
 * pulling in the Drizzle-backed `appsService` (which transitively pulls in
 * @elizaos/core and the rest of the runtime).
 */

import type { AppDeploymentStatus } from "../../db/schemas/apps";

export type { AppDeploymentStatus };

/**
 * Public-facing deployment state.
 *
 * Maps from the persisted `app_deployment_status` enum to the upper-cased
 * lifecycle the CLI polls on. `building` and `deploying` both surface as
 * `BUILDING` because the CLI does not care which sub-phase the worker is in.
 */
export type DeploymentStatus = "BUILDING" | "READY" | "ERROR" | "DRAFT";

const PERSISTED_TO_PUBLIC: Record<AppDeploymentStatus, DeploymentStatus> = {
  draft: "DRAFT",
  building: "BUILDING",
  deploying: "BUILDING",
  deployed: "READY",
  failed: "ERROR",
};

export function publicStatusFor(persisted: AppDeploymentStatus): DeploymentStatus {
  return PERSISTED_TO_PUBLIC[persisted];
}

export function deploymentIdFor(app: {
  id: string;
  last_deployed_at: Date | null;
}): string {
  const ts = app.last_deployed_at?.toISOString() ?? "0";
  return `${app.id}:${ts}`;
}
