/**
 * NODE-ONLY boot composer for the Apps / Product 2 deploy backend — the single
 * entrypoint that arms everything the foundation built, so wiring it in is one
 * call. Composes:
 *   - real per-tenant DB provisioning (makeTenantDbProvisioning -> ClusterPool ->
 *     DirectPgExecutor) into a UserDatabaseService,
 *   - the build-from-repo image resolver (AppImageBuilder over an SSH builder),
 *   - the concrete node AppDeployRunner (ensure tenant DB -> create container row
 *     carrying the per-tenant DSN -> enqueue CONTAINER_PROVISION -> link), injected
 *     into the shared appDeploymentsService,
 *   - the container executor backend (setContainerExecutorDeps), so the daemon's
 *     CONTAINER_* dispatch resolves a real provider + store.
 *
 * NODE-ONLY: pulls in `pg` (DirectPgExecutor) + SSH; call it from the
 * provisioning-worker daemon (or a node host of the deploy path), never from the
 * cloud-api Worker (workerd can't load `pg`). Until this is called, the deploy
 * path keeps its legacy stub behavior (status flip only) — so importing it is
 * always safe; nothing connects until a deploy/CONTAINER_* job actually runs.
 *
 * The cloud-api deploy route still runs on the Worker; how it triggers this node
 * flow (enqueue an APP_DEPLOY job the daemon claims, vs. a node deploy host) is
 * the deploy-route-split decision — this composer is runtime-agnostic and works
 * under either, so it doesn't pre-commit that choice.
 */

import { logger } from "../utils/logger";
import { setAppDbDeprovisioner } from "./app-db-deprovision-job-service";
import { setAppDeployRunner } from "./app-deploy-job-service";
import {
  type AppDeployRunnerDeps,
  type DefaultAppDeployRunner,
  makeDirectAppDeployRunner,
  makeNodeAppDeployRunner,
} from "./app-deploy-runner";
import { AppImageBuilder, type BuildExec } from "./app-image-builder";
import { makeBuildFromRepoResolver } from "./app-image-resolver";
import { buildContainerExecutorDeps, makeNodeBuilderExec } from "./container-executor-deps";
import { setContainerExecutorDeps } from "./container-job-service";
import { containerJobsWriter } from "./container-jobs-writer";
import { makeTenantDbProvisioning } from "./tenant-db/make-tenant-db-provisioning";
import { UserDatabaseService } from "./user-database";

export interface AppsDeployBackendConfig {
  /** Registry that app images are built + pushed to (e.g. `ghcr.io/elizaos`). Required only when `buildExec` is set. */
  registry?: string;
  /**
   * Exec seam for the image builder — SSH to a builder node. When omitted, the
   * deploy uses the PREBUILT-image path: the runner resolves the image from
   * `app.metadata.imageTag` then `APP_DEFAULT_IMAGE`, with no build step. This is
   * the path proven on staging (a pushed/known image), so the daemon can be armed
   * without standing up a builder; pass `buildExec` (+ `registry`) to enable
   * build-from-repo.
   */
  buildExec?: BuildExec;
  /** Dockerfile path within each app's repo. Default: `Dockerfile`. Only used with `buildExec`. */
  dockerfile?: string;
  /** App listen port. Default 3000. */
  port?: number;
}

/**
 * Arm the node-side Apps deploy backend. Call once at daemon boot. Safe to wire
 * unconditionally — provisioning only runs when a real deploy / CONTAINER_* job
 * is processed.
 */
export function configureAppsDeployBackend(config: AppsDeployBackendConfig): void {
  // BUILD-FROM-REPO ("Vercel-like": the platform builds the user's repo, no
  // manual image push) is armed when a registry is configured. The builder exec
  // is the explicit one if passed, else the app node's own SSH (it already has
  // Docker + buildx) — so the common case needs only `APPS_IMAGE_REGISTRY` set on
  // the daemon. With no registry, resolveImage stays undefined and the runner
  // falls back to app.metadata.imageTag / APP_DEFAULT_IMAGE (the prebuilt path) —
  // unchanged behavior.
  const registry = config.registry ?? process.env.APPS_IMAGE_REGISTRY;
  const dockerfile = config.dockerfile ?? process.env.APPS_BUILD_DOCKERFILE;
  const buildExec = config.buildExec ?? (registry ? makeNodeBuilderExec() : null);

  let resolveImage: AppDeployRunnerDeps["resolveImage"] | undefined;
  if (buildExec) {
    if (!registry) {
      throw new Error("[apps-deploy-backend] registry is required when buildExec is set");
    }
    const builder = new AppImageBuilder({ exec: buildExec });
    resolveImage = makeBuildFromRepoResolver({ builder, registry, dockerfile });
  }

  // ENCRYPTION-FREE path (env-sourced cluster admin DSN): when
  // APPS_TENANT_ADMIN_DSN is set, the daemon needs no SECRETS_MASTER_KEY — the
  // cluster admin DSN comes from env (passthrough decrypt) and the per-tenant DB
  // is provisioned directly (no encrypted app_databases write). Otherwise use the
  // standard encrypted path via UserDatabaseService.
  const adminDsnFromEnv = process.env.APPS_TENANT_ADMIN_DSN;
  let runner: DefaultAppDeployRunner;
  // Captured for the APP_DB_DEPROVISION executor below — both modes build a
  // provisioning object whose deprovisionForApp DROPs the DB + releases the slot.
  let tenantDbProvisioning: ReturnType<typeof makeTenantDbProvisioning>;
  if (adminDsnFromEnv) {
    tenantDbProvisioning = makeTenantDbProvisioning({ decrypt: async () => adminDsnFromEnv });
    runner = makeDirectAppDeployRunner({
      tenantDbProvisioning,
      jobsWriter: containerJobsWriter,
      resolveImage,
      port: config.port,
    });
  } else {
    tenantDbProvisioning = makeTenantDbProvisioning();
    const userDatabaseService = new UserDatabaseService(tenantDbProvisioning);
    runner = makeNodeAppDeployRunner({
      userDatabaseService,
      jobsWriter: containerJobsWriter,
      resolveImage,
      port: config.port,
    });
  }

  // Daemon runs APP_DEPLOY jobs (enqueued by the Worker) via this runner, and
  // CONTAINER_* jobs via the executor deps. createDeployment itself is never
  // called here (it runs on the Worker, which enqueues APP_DEPLOY).
  setAppDeployRunner(runner);
  setContainerExecutorDeps(buildContainerExecutorDeps);
  // Daemon also runs APP_DB_DEPROVISION jobs (enqueued by the Worker on app
  // delete): DROP the isolated DB + ROLE node-side and release the cluster slot
  // — the Worker can't (no `pg`), so without this the DB + slot leak (#8342).
  setAppDbDeprovisioner(tenantDbProvisioning);

  logger.info("[apps-deploy-backend] armed", {
    registry: registry ?? null,
    port: config.port ?? 3000,
    mode: adminDsnFromEnv ? "env-sourced (no field-encryption)" : "encrypted",
    images: resolveImage ? "build-from-repo" : "prebuilt (imageTag/APP_DEFAULT_IMAGE)",
  });
}
