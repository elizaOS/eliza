/**
 * Service for app deployment operations.
 *
 * Backs `POST /api/v1/apps/:id/deploy` and `GET /api/v1/apps/:id/deploy/status`.
 *
 * Source of truth is the `apps` table itself: the `deployment_status`,
 * `production_url`, and `last_deployed_at` columns added in migration 0007.
 * A deployment is identified by `<appId>:<last_deployed_at_iso>` so the
 * CLI can correlate POST → GET polls without a separate `deployments` table.
 * When a real build/upload service (Vercel or otherwise) lands, this service
 * becomes the integration boundary — callers will not need to change.
 */
import { logger } from "../utils/logger";
import {
  assertDeployable,
  type DeploymentStatus,
  deploymentIdFor,
  publicStatusFor,
} from "./app-deployments-helpers";
import { appsService } from "./apps";

export type { DeploymentStatus } from "./app-deployments-helpers";

export interface CreateDeploymentInput {
  appId: string;
  organizationId: string;
  userId: string;
  /**
   * Optional: explicit repo URL. Falls back to `app.github_repo` when omitted.
   */
  repoUrl?: string;
  /**
   * Optional: git ref / branch / commit. Defaults to the linked repo's default branch.
   */
  ref?: string;
  /**
   * Optional: relative path to a Dockerfile inside the repo.
   */
  dockerfile?: string;
  /**
   * Optional: build/runtime env to inject into the deployment.
   */
  env?: Record<string, string>;
}

export interface DeploymentRecord {
  deploymentId: string;
  status: DeploymentStatus;
  vercelUrl: string | null;
  error: string | null;
  startedAt: string;
}

export class AppDeploymentsService {
  /**
   * Mark the app as building and stamp `last_deployed_at`.
   *
   * Returns the new deployment record. The actual build/upload pipeline is
   * out of scope for this service today; callers (CLI, dashboard) poll
   * `getLatestDeployment` until status is `READY` or `ERROR`.
   *
   * The route layer is responsible for verifying ownership before calling
   * this method (mirrors the pattern used by `managed-domains.ts`).
   */
  async createDeployment(input: CreateDeploymentInput): Promise<DeploymentRecord> {
    // Surface concurrent deploys to the caller rather than silently
    // co-opting the in-flight one. The fresh `getById` is cache-hot
    // because callers (the deploy route) just fetched the row for the
    // ownership check, so this is effectively a Redis lookup.
    const existing = await appsService.getById(input.appId);
    if (!existing) {
      throw new Error("App not found");
    }
    assertDeployable(existing);

    const startedAt = new Date();
    const updated = await appsService.update(input.appId, {
      deployment_status: "building",
      last_deployed_at: startedAt,
    });
    if (!updated) {
      throw new Error("Failed to record deployment start");
    }

    logger.info("[AppDeployments] deployment queued", {
      appId: input.appId,
      organizationId: input.organizationId,
      userId: input.userId,
      repoUrl: input.repoUrl ?? updated.github_repo ?? null,
      ref: input.ref ?? null,
      dockerfile: input.dockerfile ?? null,
      envKeys: input.env ? Object.keys(input.env).length : 0,
    });

    return {
      deploymentId: deploymentIdFor(updated),
      status: publicStatusFor(updated.deployment_status),
      vercelUrl: updated.production_url ?? null,
      error: null,
      startedAt: startedAt.toISOString(),
    };
  }

  /**
   * Fetch the latest deployment record for an app.
   *
   * Returns `null` when the app has never had a deployment started (i.e.
   * `deployment_status` is still `draft` and `last_deployed_at` is null).
   */
  async getLatestDeployment(appId: string): Promise<DeploymentRecord | null> {
    const app = await appsService.getById(appId);
    if (!app) return null;
    if (app.deployment_status === "draft" && !app.last_deployed_at) {
      return null;
    }
    return {
      deploymentId: deploymentIdFor(app),
      status: publicStatusFor(app.deployment_status),
      vercelUrl: app.production_url ?? null,
      error: null,
      startedAt: app.last_deployed_at?.toISOString() ?? new Date(0).toISOString(),
    };
  }
}

export const appDeploymentsService = new AppDeploymentsService();
