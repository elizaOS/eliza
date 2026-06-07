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
import { makeNodeAppDeployRunner } from "./app-deploy-runner";
import { appDeploymentsService } from "./app-deployments";
import { AppImageBuilder, type BuildExec } from "./app-image-builder";
import { makeBuildFromRepoResolver } from "./app-image-resolver";
import { buildContainerExecutorDeps } from "./container-executor-deps";
import { setContainerExecutorDeps } from "./container-job-service";
import { containerJobsWriter } from "./container-jobs-writer";
import { makeTenantDbProvisioning } from "./tenant-db/make-tenant-db-provisioning";
import { UserDatabaseService } from "./user-database";

export interface AppsDeployBackendConfig {
  /** Registry that app images are built + pushed to (e.g. `ghcr.io/elizaos`). */
  registry: string;
  /** Exec seam for the image builder — SSH to a builder node in production. */
  buildExec: BuildExec;
  /** Dockerfile path within each app's repo. Default: `Dockerfile`. */
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
  const userDatabaseService = new UserDatabaseService(makeTenantDbProvisioning());
  const builder = new AppImageBuilder({ exec: config.buildExec });
  const resolveImage = makeBuildFromRepoResolver({
    builder,
    registry: config.registry,
    dockerfile: config.dockerfile,
  });

  const runner = makeNodeAppDeployRunner({
    userDatabaseService,
    jobsWriter: containerJobsWriter,
    resolveImage,
    port: config.port,
  });

  appDeploymentsService.setDeployRunner(runner);
  setContainerExecutorDeps(buildContainerExecutorDeps);

  logger.info("[apps-deploy-backend] armed", {
    registry: config.registry,
    port: config.port ?? 3000,
  });
}
