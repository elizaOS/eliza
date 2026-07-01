/**
 * Pure helpers + types for the app-deployments service.
 *
 * Lives in a separate module so unit tests can import these helpers without
 * pulling in the Drizzle-backed `appsService` (which transitively pulls in
 * @elizaos/core and the rest of the runtime).
 */

import type { App, AppDeploymentStatus } from "../../db/schemas/apps";
import { ApiError } from "../api/cloud-worker-errors";

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
  // Cached reads (`appsService.getById` → Redis/KV) round-trip the timestamp
  // through JSON, so `last_deployed_at` arrives as an ISO STRING, not a Date.
  // Accept both and coerce — calling `.toISOString()` on a string 500s the
  // deploy-status route (the real-staging deploy bug behind #9300).
  last_deployed_at: Date | string | null;
}): string {
  const ts = app.last_deployed_at ? new Date(app.last_deployed_at).toISOString() : "0";
  return `${app.id}:${ts}`;
}

/**
 * Throws a 409 `ApiError` if the given app already has a deployment in
 * flight. Otherwise no-ops. Called by `createDeployment` so concurrent
 * `POST /deploy` invocations don't silently overwrite each other's
 * `last_deployed_at` stamp — one caller wins and the loser gets a
 * stale deploymentId pointed at the winner's record.
 *
 * Note: this is a check-then-act guard, not a database-level lock. A
 * truly race-free path would do a conditional UPDATE in the
 * `apps` repo. For the realistic case (CLI invocations seconds apart)
 * the guard surfaces the conflict to the caller, which is what
 * Greptile flagged on PR #7804.
 */
export function assertDeployable(app: { deployment_status: AppDeploymentStatus }): void {
  if (app.deployment_status === "building") {
    throw new ApiError(
      409,
      "session_not_ready",
      "A deployment is already in progress for this app",
    );
  }
}

/**
 * Modeled local-vs-remote distinction for an app (#9145, Problem #2 / Q3).
 *
 * The `apps` schema has no explicit `local`/`remote` column; the distinction
 * is derived from deployment state. An app is REMOTE once it has reached a
 * deploy lifecycle that yields a managed-container URL. Otherwise it is LOCAL:
 * it runs only in the desktop/device runtime against its own `app_url`.
 *
 * This is the single source of truth for the distinction — UI, CLI, and parity
 * checks should derive `local` vs `remote` through here rather than re-deriving
 * `deployment_status !== "draft"` ad hoc.
 */
export type AppKind = "local" | "remote";

/** Fields required to classify an app as local or remote. */
export type AppKindInput = Pick<App, "deployment_status" | "production_url">;

/**
 * An app is REMOTE iff it has reached a deploy lifecycle that yields a managed
 * container URL: `deployed` (live), or in-flight `building`/`deploying` once a
 * `production_url` has been assigned. `draft` and `failed` are LOCAL — `failed`
 * has no live container, and a build that never produced a `production_url`
 * stays LOCAL until one is assigned.
 */
export function appKindFor(app: AppKindInput): AppKind {
  if (app.deployment_status === "deployed") return "remote";
  if (
    (app.deployment_status === "building" || app.deployment_status === "deploying") &&
    typeof app.production_url === "string" &&
    app.production_url.length > 0
  ) {
    return "remote";
  }
  return "local";
}

export function isRemoteApp(app: AppKindInput): boolean {
  return appKindFor(app) === "remote";
}

export function isLocalApp(app: AppKindInput): boolean {
  return appKindFor(app) === "local";
}
