/**
 * Pure helpers + types for the app-deployments service.
 *
 * Lives in a separate module so unit tests can import these helpers without
 * pulling in the Drizzle-backed `appsService` (which transitively pulls in
 * @elizaos/core and the rest of the runtime).
 */

import type { AppDeploymentStatus } from "../../db/schemas/apps";
import { CONTAINER_PRICING } from "../constants/pricing";
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

export function deploymentIdFor(app: { id: string; last_deployed_at: Date | null }): string {
  const ts = app.last_deployed_at?.toISOString() ?? "0";
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

/** Upfront deploy charge surfaced to callers before a build is queued. */
export const APP_DEPLOY_UPFRONT_CHARGE_USD = CONTAINER_PRICING.DEPLOYMENT;

/** Idempotency key for a single queued deploy (`<appId>:<startedAt iso>`). */
export function deployCreditIdempotencyKey(deploymentId: string): string {
  return `app_deploy:${deploymentId}`;
}

/**
 * Throws 402 when the org cannot cover the one-time deploy charge. The actual
 * debit happens in {@link deductDeployCredits} once the deploy is stamped.
 */
export function assertSufficientDeployCredits(creditBalanceUsd: number): void {
  if (creditBalanceUsd < APP_DEPLOY_UPFRONT_CHARGE_USD) {
    const deficit = Math.max(APP_DEPLOY_UPFRONT_CHARGE_USD - creditBalanceUsd, 0.01);
    throw new ApiError(
      402,
      "insufficient_credits",
      `Insufficient credits to deploy. Required: $${APP_DEPLOY_UPFRONT_CHARGE_USD.toFixed(2)}, ` +
        `available: $${creditBalanceUsd.toFixed(2)}. Add at least $${deficit.toFixed(2)} at /dashboard/billing.`,
    );
  }
}
