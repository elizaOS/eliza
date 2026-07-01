/**
 * NODE-ONLY boot composer for the Apps / Product 2 deploy backend — the single
 * entrypoint that arms everything the foundation built, so wiring it in is one
 * call. Composes:
 *   - real per-tenant DB provisioning (makeTenantDbProvisioning -> ClusterPool ->
 *     DirectPgExecutor) into a UserDatabaseService,
 *   - the build-from-repo image resolver (AppImageBuilder over an SSH builder) —
 *     wired ONLY when build-from-repo is explicitly armed; off by default, so the
 *     composer is prebuilt-image-only unless the arming gate below resolves a
 *     builder (issue #9768: build-from-repo deferred for launch),
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
  type DefaultAppDeployRunner,
  makeDirectAppDeployRunner,
  makeNodeAppDeployRunner,
} from "./app-deploy-runner";
import { AppImageBuilder, type BuildExec } from "./app-image-builder";
import {
  type AppImageResolver,
  composeImageResolvers,
  makeBuildFromRepoResolver,
  makePrebuiltImageMapResolver,
} from "./app-image-resolver";
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
   * deploy uses the PREBUILT-image path, with no build step. Repo-backed apps
   * need an operator prebuilt map entry or explicit `app.metadata.imageTag`;
   * non-repo legacy/smoke apps may still fall through to `APP_DEFAULT_IMAGE`.
   * This is the path proven on staging (a pushed/known image), so the daemon can
   * be armed without standing up a builder; pass `buildExec` (+ `registry`) to
   * enable build-from-repo.
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
  // manual image push) is NOT armed by a registry alone. `APPS_IMAGE_REGISTRY`
  // only sets the push/pull target; build-from-repo additionally requires a
  // builder exec. With no explicit `buildExec`, that comes from
  // `makeNodeBuilderExec()`, which returns a builder ONLY when the container
  // backend is configured AND `APPS_BUILD_FROM_REPO_ENABLED=1` AND an isolated
  // builder host resolves (a dedicated `APPS_BUILDS_HOST`, or the runtime node
  // via `APPS_BUILD_ON_RUNTIME_NODE=1`) — see `makeNodeBuilderExec` /
  // `decideBuilderArming`. So `APPS_IMAGE_REGISTRY` set with build-from-repo
  // NOT armed yields `buildExec === null` → `buildResolver` undefined → the
  // runner falls back through the optional APP_PREBUILT_IMAGES map, then
  // app.metadata.imageTag / APP_DEFAULT_IMAGE (the prebuilt-image path).
  // "Deferred" (issue #9768) is the default safe state: registry-only stays
  // prebuilt-only. Coverage: `__tests__/node-builder-exec.test.ts`.
  const registry = config.registry ?? process.env.APPS_IMAGE_REGISTRY;
  const dockerfile = config.dockerfile ?? process.env.APPS_BUILD_DOCKERFILE;
  const buildExec = config.buildExec ?? (registry ? makeNodeBuilderExec() : null);

  let buildResolver: AppImageResolver | undefined;
  if (buildExec) {
    if (!registry) {
      throw new Error("[apps-deploy-backend] registry is required when buildExec is set");
    }
    const builder = new AppImageBuilder({ exec: buildExec });
    buildResolver = makeBuildFromRepoResolver({ builder, registry, dockerfile });
  }
  const prebuiltMapResolver = makePrebuiltImageMapResolver();
  const resolveImage = composeImageResolvers(buildResolver, prebuiltMapResolver);
  const imageMode = buildResolver
    ? prebuiltMapResolver
      ? "build-from-repo + APP_PREBUILT_IMAGES"
      : "build-from-repo"
    : prebuiltMapResolver
      ? "APP_PREBUILT_IMAGES + imageTag/APP_DEFAULT_IMAGE"
      : "prebuilt (imageTag/APP_DEFAULT_IMAGE)";

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
    images: imageMode,
  });
}
