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
import { organizationsRepository } from "../../db/repositories/organizations";
import { logger } from "../utils/logger";
import { deductDeployCredits } from "./app-deploy-billing";
import type { AppDeployRunner } from "./app-deploy-orchestrator";
import {
  assertDeployable,
  assertSufficientDeployCredits,
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

/**
 * Enqueue an APP_DEPLOY job (pg-free) so the daemon runs the real isolated
 * deploy. The Worker deploy route wires this so `createDeployment` never touches
 * `pg`/SSH on the workerd request path.
 */
export type AppDeployEnqueuer = (p: {
  appId: string;
  organizationId: string;
  userId: string;
}) => Promise<unknown>;

export class AppDeploymentsService {
  private deployRunner?: AppDeployRunner;
  private deployEnqueuer?: AppDeployEnqueuer;

  /**
   * @param deployRunner When wired (Apps / Product 2), a deploy provisions a
   *   real isolated container after the app is marked `building`. When omitted,
   *   `createDeployment` keeps its legacy behavior (status flip only).
   */
  constructor(deployRunner?: AppDeployRunner) {
    this.deployRunner = deployRunner;
  }

  /**
   * Runtime-inject the DIRECT deploy backend (node/test path): `createDeployment`
   * runs the runner inline. Production prefers {@link setDeployEnqueuer} so the
   * Worker stays pg-free. Idempotent; legacy behavior holds until set.
   */
  setDeployRunner(runner: AppDeployRunner): void {
    this.deployRunner = runner;
  }

  /**
   * Runtime-inject the WORKER deploy trigger: `createDeployment` enqueues an
   * APP_DEPLOY job (pg-free) the daemon runs. Takes precedence over a direct
   * runner. Wired in cloud-api boot.
   */
  setDeployEnqueuer(enqueuer: AppDeployEnqueuer): void {
    this.deployEnqueuer = enqueuer;
  }

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

    const org = await organizationsRepository.findById(input.organizationId);
    if (!org) {
      throw new Error("Organization not found");
    }
    assertSufficientDeployCredits(Number(org.credit_balance));

    const startedAt = new Date();
    const updated = await appsService.update(input.appId, {
      deployment_status: "building",
      last_deployed_at: startedAt,
    });
    if (!updated) {
      throw new Error("Failed to record deployment start");
    }

    const deploymentId = deploymentIdFor(updated);
    try {
      await deductDeployCredits({
        organizationId: input.organizationId,
        userId: input.userId,
        appId: input.appId,
        deploymentId,
      });
    } catch (error) {
      await appsService.update(input.appId, { deployment_status: "failed" });
      throw error;
    }

    // Apps lane (Product 2): trigger the real isolated deploy.
    //   WORKER  — enqueue an APP_DEPLOY job (pg-free); the daemon runs it.
    //   NODE/test — run the injected runner inline.
    //   neither wired — legacy stub (status flip only).
    // On failure, mark the app errored so the caller's status poll reflects it.
    if (this.deployEnqueuer || this.deployRunner) {
      try {
        if (this.deployEnqueuer) {
          await this.deployEnqueuer({
            appId: input.appId,
            organizationId: input.organizationId,
            userId: input.userId,
          });
        } else if (this.deployRunner) {
          await this.deployRunner.run(input.appId);
        }
      } catch (error) {
        logger.error("[AppDeployments] deploy trigger failed", {
          appId: input.appId,
          error: error instanceof Error ? error.message : String(error),
        });
        await appsService.update(input.appId, { deployment_status: "failed" });
        throw error;
      }
    }

    logger.info("[AppDeployments] deployment queued", {
      appId: input.appId,
      organizationId: input.organizationId,
      userId: input.userId,
      deploymentId,
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
