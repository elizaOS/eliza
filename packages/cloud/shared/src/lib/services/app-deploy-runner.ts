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
 * The image is resolved from the app deploy source. `resolveImage` reads, in
 * order:
 *   1. explicit deploy options passed through the APP_DEPLOY job (repo/ref/
 *      Dockerfile from `POST /api/v1/apps/:id/deploy`),
 *   2. the app's linked repo / metadata image ref,
 *   3. `APP_DEFAULT_IMAGE` env (a placeholder runtime image for smoke tests).
 * It throws if none resolve, surfacing a clear "no image to deploy" rather than
 * provisioning an empty container.
 *
 * Every dependency is injected, so the runner is unit-testable with fakes and the
 * load-bearing property — `containers.environment_vars.DATABASE_URL` is the
 * per-tenant DSN, never the shared agent URL — is asserted directly.
 */

import { appDatabasesRepository } from "../../db/repositories/app-databases";
import { containersRepository } from "../../db/repositories/containers";
import { containersEnv } from "../config/containers-env";
import { logger } from "../utils/logger";
import { toNewContainer } from "./app-container-record";
import { resolveAppDatabaseMode } from "./app-database-mode";
import {
  type AppDeployDeps,
  type AppDeployRunner,
  type AppDeployRunOptions,
  deployApp,
  type NewAppContainerRow,
} from "./app-deploy-orchestrator";
import { deriveAppPublicUrl } from "./app-url";
import { appsService } from "./apps";
import { imageRequiresDigestPin, isCodingContainerImageAllowed } from "./coding-containers";
import { ContainerJobEnqueuer, type ContainerJobsWriter } from "./container-job-service";
import { getOrgImageNamespaces } from "./org-image-namespaces";
import type { TenantDbProvisioning } from "./tenant-db/tenant-db-provisioning";
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
  /**
   * Per-org image-namespace extension lookup (operator-granted namespaces from
   * `organizations.settings.allowed_image_namespaces`). Injected for tests;
   * defaults to the DB-backed {@link getOrgImageNamespaces}.
   */
  orgImageNamespaces?: (organizationId: string) => Promise<string[]>;
  /** App listen port. Default 3000. */
  port?: number;
}

export async function resolveImageRef(
  deps: AppDeployRunnerDeps,
  app: {
    id: string;
    name: string;
    metadata: Record<string, unknown>;
    repoUrl?: string;
    /** Owning org — enables its per-org image-namespace extension when set. */
    organizationId?: string;
  },
): Promise<string> {
  const fromResolver = deps.resolveImage ? await deps.resolveImage(app) : undefined;
  const fromMetadata =
    typeof app.metadata?.imageTag === "string" ? (app.metadata.imageTag as string) : undefined;
  // A repo-configured app whose build-from-repo is disabled (no resolver wired,
  // i.e. APPS_IMAGE_REGISTRY unset) must NOT silently fall back to
  // APP_DEFAULT_IMAGE — that would deploy a default/smoke image in place of the
  // user's code (a silent wrong deploy). Require an explicit prebuilt image
  // instead. (build-from-repo is intentionally deferred — prebuilt-image only.)
  if (app.repoUrl && !fromResolver && !fromMetadata) {
    throw new Error(
      `App ${app.id} builds from a git repo, but build-from-repo is disabled ` +
        `(no APPS_IMAGE_REGISTRY). Set a prebuilt image via metadata.imageTag, ` +
        `or enable build-from-repo.`,
    );
  }
  const image = fromResolver ?? fromMetadata ?? process.env.APP_DEFAULT_IMAGE;
  if (!image) {
    throw new Error(
      `No image to deploy for app ${app.id}: pass resolveImage, set app.metadata.imageTag, or APP_DEFAULT_IMAGE`,
    );
  }
  // SECURITY: an app deploy runs an image on our shared docker nodes. Gate the
  // resolved image on the APPS-DEPLOY allowlist (first-party `ghcr.io/elizaos/*`
  // ONLY by default — DELIBERATELY separate from the coding-container allowlist,
  // which also carries personal/side-product namespaces for its BYO-image path),
  // so a caller-supplied `metadata.imageTag` (or a mis-set APP_DEFAULT_IMAGE)
  // cannot run an arbitrary off-namespace image. Fail-closed: empty allowlist
  // denies. The default allowlist covers the first-party elizaOS namespace, so
  // the stamped template image / APP_DEFAULT_IMAGE under it pass unchanged.
  // When the platform allowlist denies, the owning org's operator-granted
  // namespace extension (organizations.settings.allowed_image_namespaces) is
  // consulted — additive, fail-closed, scoped to that org only. This is the
  // path that lets a user's own `ghcr.io/<login>/*` app image deploy without
  // widening the platform-wide list for every tenant.
  const allowlist = containersEnv.appsDeployImageAllowlist();
  let imageAllowed = isCodingContainerImageAllowed(image, allowlist);
  if (!imageAllowed && app.organizationId) {
    const lookup = deps.orgImageNamespaces ?? getOrgImageNamespaces;
    let orgNamespaces: string[];
    try {
      orgNamespaces = await lookup(app.organizationId);
    } catch (error) {
      // error-policy:J2 context-adding rethrow; a failed namespace lookup is an internal authorization failure, not "no grant".
      throw new Error(
        `Failed to resolve app deploy image namespaces for organization ${app.organizationId} while deploying app ${app.id}`,
        { cause: error },
      );
    }
    imageAllowed = isCodingContainerImageAllowed(image, orgNamespaces);
  }
  if (!imageAllowed) {
    const permitted = allowlist.length > 0 ? allowlist.join(", ") : "(none configured)";
    throw new Error(
      `Image '${image}' is not permitted for app ${app.id}: it is outside the ` +
        `allowed image namespaces (${permitted}). Set app.metadata.imageTag to an ` +
        `allowlisted image, widen APPS_DEPLOY_IMAGE_ALLOWLIST, or ask an operator ` +
        `to grant the namespace to your organization (settings.allowed_image_namespaces).`,
    );
  }
  // SECURITY (opt-in, default OFF): when the digest-pin gate is armed, reject a
  // mutable `:tag`/`:latest` reference so the registry cannot swap the bytes
  // behind an allowed name after this check. This is the SAME gate the two
  // container routes (`/v1/containers`, `/v1/coding-containers`) enforce; an
  // app deploy is the third shared-node image path, so it must enforce it too —
  // otherwise CONTAINER_IMAGE_REQUIRE_DIGEST=true would still let an app deploy
  // run a mutable tag while the routes reject it.
  if (imageRequiresDigestPin(image, containersEnv.requireDigestPinnedImages())) {
    throw new Error(
      `Image '${image}' for app ${app.id} must be pinned to a full sha256 digest ` +
        `(e.g. repo@sha256:<64 hex>): the digest-pin gate ` +
        `(CONTAINER_IMAGE_REQUIRE_DIGEST) is enabled and a mutable tag can be ` +
        `swapped after this check.`,
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

  async run(appId: string, options: AppDeployRunOptions = {}): Promise<void> {
    const app = await appsService.getById(appId);
    if (!app) {
      throw new Error(`App ${appId} not found`);
    }

    const appMetadata = (app.metadata as Record<string, unknown>) ?? {};
    const deployMetadata = {
      ...appMetadata,
      ...(options.repoUrl ? { repoUrl: options.repoUrl } : {}),
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.dockerfile ? { dockerfile: options.dockerfile } : {}),
    };
    const image = await resolveImageRef(this.deps, {
      id: app.id,
      name: app.name,
      metadata: deployMetadata,
      repoUrl: app.github_repo ?? undefined,
      organizationId: app.organization_id,
    });
    const containerName = containerNameForApp(appId);

    const enqueuer = new ContainerJobEnqueuer(this.deps.jobsWriter);

    // Retire the app's pre-existing container row(s) BEFORE creating the new one.
    // Every deploy creates a fresh `containers` row under the same project key
    // (project_name = appId); without retiring the old ones, their stale
    // `stopped`/`failed` rows keep counting against the per-org container quota
    // forever (the quota readers exclude only `deleting`/`deleted`). We flip each
    // prior row to `deleting` immediately (so it stops counting before the new
    // row's quota check runs) and enqueue a CONTAINER_DELETE so the daemon
    // removes the old container + releases its node slot. Net effect: at most one
    // active row per app.
    await this.retirePriorContainers(app.organization_id, appId, enqueuer);

    const createContainerRow =
      this.deps.createContainerRow ??
      (async (row: NewAppContainerRow) => {
        // Enforce the per-org container quota atomically — the same cap
        // (credit-balance-derived) the normal /v1/containers API uses. Without
        // this, the apps deploy path bypassed quota entirely and one org could
        // spin up unbounded 24/7 containers (DoS / unbounded cost). Throws
        // QuotaExceededError when over cap; the deploy route surfaces it.
        const created = await containersRepository.createWithQuotaCheck(toNewContainer(row));
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
        ...(options.env ? { env: options.env } : {}),
        // Per-app choice (apps.metadata.databaseMode, default "none"): a stateless
        // app provisions no DB; an "isolated" app gets its own per-tenant Postgres.
        databaseMode: resolveAppDatabaseMode(appMetadata),
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

  /**
   * Retire every pre-existing container row for an app so stale rows from prior
   * deploys stop counting against the per-org container quota (and the old
   * containers get torn down on the node). Each prior row is flipped to
   * `deleting` immediately — a non-quota-counting state — so the quota count
   * drops BEFORE the new row's createWithQuotaCheck runs (the enqueued
   * CONTAINER_DELETE is async and would otherwise race the new row's check). The
   * daemon's CONTAINER_DELETE then does the real `docker rm -f` + node-slot
   * release and flips the row to terminal `deleted`. Best-effort per row: a
   * failure to retire one row is logged but never blocks the new deploy.
   */
  private async retirePriorContainers(
    organizationId: string,
    appId: string,
    enqueuer: ContainerJobEnqueuer,
  ): Promise<void> {
    const prior = await containersRepository.findUndeletedByProjectName(organizationId, appId);
    for (const row of prior) {
      try {
        // Mark `deleting` up front so it stops counting toward quota before the
        // new row's quota check; the daemon's CONTAINER_DELETE finishes the job.
        await containersRepository.updateStatus(row.id, "deleting");
        await enqueuer.enqueueDelete({ containerId: row.id, organizationId });
        logger.info("[AppDeployRunner] retired prior container row", {
          appId,
          containerId: row.id,
        });
      } catch (error) {
        logger.warn("[AppDeployRunner] failed to retire prior container row", {
          appId,
          containerId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
 * NODE factory (ENCRYPTION-FREE) — `ensureTenantDb` provisions the isolated
 * tenant DB DIRECTLY via the injected {@link TenantDbProvisioning}, returning the
 * DSN without routing through `userDatabaseService`. It needs no
 * `SECRETS_MASTER_KEY` — the per-tenant DSN still rides into the container's
 * `environment_vars`. Use when the daemon has no field-encryption key (the
 * cluster admin DSN is env-sourced via a passthrough decrypt). Isolation is
 * unchanged: REVOKE-CONNECT per tenant still applies.
 *
 * It DOES persist the canonical `app_databases` row at provision time (#8342):
 * without it, app delete (`UserDatabaseService.cleanupDatabase` →
 * `findStateByAppIdForWrite`) finds no row and returns early, so the per-tenant
 * DB + ROLE are never DROPped and the cluster slot is never released — the DB
 * leaks (we keep paying) and the cluster's finite slots drift up until they
 * exhaust. The row carries the per-tenant DSN as PLAINTEXT (this mode has no
 * master key to encrypt with); that is safe because the teardown path decrypts
 * with `fieldEncryption.decryptIfNeeded`, which passes plaintext through — the
 * exact env-DSN case `dispatchAppDbDeprovisionJob` already documents. So the
 * standard delete → APP_DB_DEPROVISION → DROP + releaseSlot path fires unchanged.
 */
export function makeDirectAppDeployRunner(args: {
  tenantDbProvisioning: TenantDbProvisioning;
  jobsWriter: ContainerJobsWriter;
  resolveImage?: AppDeployRunnerDeps["resolveImage"];
  port?: number;
}): DefaultAppDeployRunner {
  return new DefaultAppDeployRunner({
    ensureTenantDb: async (appId) => {
      const { dsn } = await args.tenantDbProvisioning.provisionForApp(appId);
      // Persist the teardown-readable canonical record keyed by appId so app
      // delete can resolve the per-tenant DSN and run the DROP + slot release.
      // Stored as plaintext — see the factory header; decryptIfNeeded passes
      // plaintext through on the daemon side.
      try {
        await appDatabasesRepository.updateState(appId, {
          user_database_uri: dsn,
          user_database_status: "ready",
          user_database_error: null,
        });
      } catch (error) {
        // The tenant DB + cluster slot already exist, but persisting the canonical
        // row failed — without that row, app delete can't resolve the DSN to DROP
        // the DB or release the slot, so both would leak permanently. Compensate
        // by tearing the just-provisioned DB down (DROP DB + release slot) before
        // rethrowing, so a failed persist self-heals instead of leaking.
        await args.tenantDbProvisioning.deprovisionForApp(appId, dsn).catch((teardownError) => {
          logger.error("[AppDeployRunner] compensating tenant-DB teardown failed", {
            appId,
            error: teardownError instanceof Error ? teardownError.message : String(teardownError),
          });
        });
        throw error;
      }
      return dsn;
    },
    jobsWriter: args.jobsWriter,
    resolveImage: args.resolveImage,
    port: args.port,
  });
}

// NOTE: there used to be a `makeWorkerAppDeployRunner` here — a `pg`-free factory
// that ran `provisionDatabase` over a backend-less `UserDatabaseService`, taking
// the shared-DB fallback (no `CREATE ROLE`/`REVOKE CONNECT`, isolation by UUID
// only) while still being used for "isolated" apps. It had zero callers (the live
// path enqueues an APP_DEPLOY job → the node daemon runs `makeNodeAppDeployRunner`
// with real per-tenant DDL, and an unarmed daemon hard-fails). It was removed so
// nobody can re-wire a silent isolation downgrade; `provisionDatabase` now also
// fail-closes when no provisioning backend is wired.
