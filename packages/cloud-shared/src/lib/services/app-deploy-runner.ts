/**
 * Concrete AppDeployRunner (Apps / Product 2) — the integration boundary that
 * implements the {@link AppDeployRunner} seam `AppDeploymentsService` calls after
 * marking an app `building`. It loads the app, resolves the image + container
 * name, composes `deployApp`'s injected deps over the real services/repos, and
 * runs the orchestration: ensure isolated tenant DB -> create container row
 * carrying that DSN -> enqueue CONTAINER_PROVISION -> link container to app.
 *
 * ── THE RUNTIME SPLIT (load-bearing) ─────────────────────────────────────────
 * `deployApp.ensureTenantDb` must run `CREATE DATABASE`/`CREATE ROLE` DDL, which
 * goes through `DirectPgExecutor` (node-`pg`). The cloud-api deploy route runs on
 * Cloudflare Workers (workerd) where `pg` does NOT load. So there are two ways to
 * wire `ensureTenantDb`, and the factory picks the right one by runtime:
 *
 *   (A) NODE runtime (the provisioning-worker daemon, or any node host of the
 *       deploy path): `ensureTenantDb` runs the real isolated provision inline
 *       via `userDatabaseService.provisionDatabase` backed by the injected
 *       `SqlTenantDbProvisioning` (DirectPgExecutor). Returns the per-tenant DSN.
 *
 *   (B) WORKER runtime (cloud-api): `ensureTenantDb` must NOT touch `pg`. The
 *       Worker-safe factory provisions in SHARED-DB fallback mode at request time
 *       (no DDL — just returns the shared DATABASE_URL the legacy path used), OR,
 *       once the daemon owns tenant-DB DDL, returns a placeholder the daemon
 *       overwrites before the container boots. Today's foundation keeps the
 *       isolated DDL on the node side, so the Worker factory uses the shared-DB
 *       provision (still isolated by app/agent UUID via plugin-sql) and leaves
 *       a TODO to move DDL into the CONTAINER_PROVISION executor when the daemon
 *       gains an ensure-tenant-db step. Either way the deploy route never calls
 *       `pg`, satisfying the workerd constraint.
 *
 * The image is resolved from the build-pipeline output. There is no build service
 * yet (app-deployments.ts notes this), so `resolveImage` reads, in order:
 *   1. an explicit override passed into the runner (CI / tests),
 *   2. `app.metadata.imageTag` (where a future build step writes the built ref),
 *   3. `APP_DEFAULT_IMAGE` env (a placeholder runtime image for smoke tests).
 * It throws if none resolve, surfacing a clear "no image to deploy" rather than
 * provisioning an empty container.
 *
 * Every dependency is injected, so the runner is unit-testable with fakes and the
 * load-bearing property — `containers.environment_vars.DATABASE_URL` is the
 * per-tenant DSN, never the shared agent URL — is asserted directly.
 */

import { containersRepository } from "../../db/repositories/containers";
import type { NewContainer } from "../../db/schemas/containers";
import { logger } from "../utils/logger";
import {
  type AppDeployDeps,
  type AppDeployRunner,
  deployApp,
  type NewAppContainerRow,
} from "./app-deploy-orchestrator";
import { deriveAppPublicUrl } from "./app-url";
import { appsService } from "./apps";
import { ContainerJobEnqueuer, type ContainerJobsWriter } from "./container-job-service";
import type { UserDatabaseService } from "./user-database";

/** Everything the runner needs to compose `deployApp`'s deps. Injected for tests. */
export interface AppDeployRunnerDeps {
  /**
   * Ensures the app's isolated per-tenant DB exists and returns its DSN.
   *
   * NODE: `(appId, appName) => userDatabaseService.provisionDatabase(...)` over a
   * `SqlTenantDbProvisioning` (DirectPgExecutor) — the real isolated DDL path.
   * WORKER: a `pg`-free provision (shared-DB fallback) — see the file header.
   *
   * Receives `appName` for provisioning/logging parity with provisionDatabase.
   */
  ensureTenantDb: (appId: string, appName: string) => Promise<string>;
  /** Persists a container row; returns its id. Defaults to `containersRepository.create`. */
  createContainerRow?: (row: NewAppContainerRow) => Promise<{ containerId: string }>;
  /** Enqueues the provision job. Defaults to a `ContainerJobEnqueuer` over the writer. */
  jobsWriter: ContainerJobsWriter;
  /**
   * Resolve the full image reference (`ghcr.io/owner/app:tag`) to deploy. When
   * omitted, falls back to `app.metadata.imageTag` then `APP_DEFAULT_IMAGE`.
   */
  resolveImage?: (app: {
    id: string;
    name: string;
    metadata: Record<string, unknown>;
    /** The app's git repo (apps.github_repo) — the build pipeline's context. */
    repoUrl?: string;
  }) => Promise<string | undefined> | string | undefined;
  /** App listen port. Default 3000. */
  port?: number;
}

/** Map the orchestrator's NewAppContainerRow onto a `containers` insert. */
export function toNewContainer(row: NewAppContainerRow): NewContainer {
  return {
    name: row.containerName,
    // project_name = appId so the executor's AppContainerStore can recover the
    // appId from the row, and so the partial unique index keys per-app.
    project_name: row.appId,
    organization_id: row.organizationId,
    user_id: row.userId,
    image_tag: row.image,
    port: row.port,
    // The app's OWN isolated DSN rides here — never the shared agent DATABASE_URL.
    environment_vars: row.environmentVars,
    // Stash appId in metadata too (belt-and-suspenders for the store's getById).
    metadata: { appId: row.appId },
    status: "pending",
  };
}

async function resolveImageRef(
  deps: AppDeployRunnerDeps,
  app: { id: string; name: string; metadata: Record<string, unknown>; repoUrl?: string },
): Promise<string> {
  const fromResolver = deps.resolveImage ? await deps.resolveImage(app) : undefined;
  const fromMetadata =
    typeof app.metadata?.imageTag === "string" ? (app.metadata.imageTag as string) : undefined;
  const fromEnv = process.env.APP_DEFAULT_IMAGE;
  const image = fromResolver ?? fromMetadata ?? fromEnv;
  if (!image) {
    throw new Error(
      `No image to deploy for app ${app.id}: pass resolveImage, set app.metadata.imageTag, or APP_DEFAULT_IMAGE`,
    );
  }
  return image;
}

/** A stable, DNS/Docker-safe container name for an app: `app-<first 12 of id>`. */
export function containerNameForApp(appId: string): string {
  const slug = appId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `app-${slug.slice(0, 12)}`;
}

export class DefaultAppDeployRunner implements AppDeployRunner {
  private readonly deps: AppDeployRunnerDeps;

  constructor(deps: AppDeployRunnerDeps) {
    this.deps = deps;
  }

  async run(appId: string): Promise<void> {
    const app = await appsService.getById(appId);
    if (!app) {
      throw new Error(`App ${appId} not found`);
    }

    const image = await resolveImageRef(this.deps, {
      id: app.id,
      name: app.name,
      metadata: (app.metadata as Record<string, unknown>) ?? {},
      repoUrl: app.github_repo ?? undefined,
    });
    const containerName = containerNameForApp(appId);

    const enqueuer = new ContainerJobEnqueuer(this.deps.jobsWriter);
    const createContainerRow =
      this.deps.createContainerRow ??
      (async (row: NewAppContainerRow) => {
        const created = await containersRepository.create(toNewContainer(row));
        return { containerId: created.id };
      });

    const orchestratorDeps: AppDeployDeps = {
      ensureTenantDb: (id) => this.deps.ensureTenantDb(id, app.name),
      createContainerRow,
      enqueueProvision: (p) => enqueuer.enqueueProvision(p),
      linkContainerToApp: async (id, containerId) => {
        // Re-read for the freshest metadata before merging containerId in.
        const current = await appsService.getById(id);
        const existingMeta = (current?.metadata as Record<string, unknown>) ?? {};
        // The public URL is deterministic from the container id (same ingress
        // derivation as the agent path), so the deploy-status poll can surface
        // it immediately. Skipped when no public base domain is configured.
        const endpoint = deriveAppPublicUrl(containerId);
        await appsService.update(id, {
          metadata: { ...existingMeta, containerId },
          ...(endpoint ? { production_url: endpoint.url } : {}),
        });
      },
    };

    const result = await deployApp(
      {
        appId,
        organizationId: app.organization_id,
        userId: app.created_by_user_id,
        containerName,
        image,
        port: this.deps.port ?? 3000,
      },
      orchestratorDeps,
    );

    logger.info("[AppDeployRunner] deploy provisioned", {
      appId,
      containerId: result.containerId,
      jobId: result.jobId,
      image,
    });
  }
}

/**
 * NODE factory — the real isolated provision path. `ensureTenantDb` runs the
 * tenant-DB DDL inline via the injected `userDatabaseService` (which must have
 * been constructed with a `SqlTenantDbProvisioning`/DirectPgExecutor; otherwise
 * it transparently falls back to shared-DB mode). Use this where the deploy path
 * runs on node (the daemon, or a node sidecar hosting the deploy route).
 */
export function makeNodeAppDeployRunner(args: {
  userDatabaseService: UserDatabaseService;
  jobsWriter: ContainerJobsWriter;
  resolveImage?: AppDeployRunnerDeps["resolveImage"];
  port?: number;
}): DefaultAppDeployRunner {
  return new DefaultAppDeployRunner({
    ensureTenantDb: async (appId, appName) => {
      const provisioned = await args.userDatabaseService.provisionDatabase(appId, appName);
      if (!provisioned.success || !provisioned.connectionUri) {
        throw new Error(
          `ensureTenantDb failed for app ${appId}: ${provisioned.error ?? "no connection URI"}`,
        );
      }
      return provisioned.connectionUri;
    },
    jobsWriter: args.jobsWriter,
    resolveImage: args.resolveImage,
    port: args.port,
  });
}

/**
 * WORKER factory — `pg`-free. `ensureTenantDb` runs `provisionDatabase` over a
 * `userDatabaseService` constructed WITHOUT a tenant-DB provisioning backend, so
 * it takes the shared-DB fallback (returns process.env.DATABASE_URL; no DDL, no
 * `pg`). Isolation in this mode is by app/agent UUID scoping in plugin-sql, not
 * by REVOKE-CONNECT. Use this in cloud-api (workerd) until tenant-DB DDL is moved
 * into the CONTAINER_PROVISION executor (then this factory enqueues instead).
 *
 * The injected `userDatabaseService` here is the bare singleton (no provisioning
 * backend) — passing it explicitly keeps the dependency visible and testable.
 */
export function makeWorkerAppDeployRunner(args: {
  userDatabaseService: UserDatabaseService;
  jobsWriter: ContainerJobsWriter;
  resolveImage?: AppDeployRunnerDeps["resolveImage"];
  port?: number;
}): DefaultAppDeployRunner {
  return new DefaultAppDeployRunner({
    ensureTenantDb: async (appId, appName) => {
      const provisioned = await args.userDatabaseService.provisionDatabase(appId, appName);
      if (!provisioned.success || !provisioned.connectionUri) {
        throw new Error(
          `ensureTenantDb (shared) failed for app ${appId}: ${provisioned.error ?? "no connection URI"}`,
        );
      }
      return provisioned.connectionUri;
    },
    jobsWriter: args.jobsWriter,
    resolveImage: args.resolveImage,
    port: args.port,
  });
}
