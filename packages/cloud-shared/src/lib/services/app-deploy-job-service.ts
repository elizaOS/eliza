/**
 * APP_DEPLOY job service (Apps / Product 2) — the runtime split that lets the
 * cloud-api Worker trigger a real isolated deploy without ever touching `pg`.
 *
 * The Worker deploy route ENQUEUES an APP_DEPLOY job (a plain DB insert, no `pg`)
 * via {@link enqueueAppDeploy}; the provisioning-worker daemon claims it and runs
 * the node {@link AppDeployRunner} via {@link dispatchAppDeployJob} (ensure
 * tenant DB -> create container row with the per-tenant DSN -> enqueue
 * CONTAINER_PROVISION -> link). This keeps all DDL/SSH on the node side
 * (workerd can't load `pg`) while the deploy request stays Worker-native.
 *
 * The executor backend is injected at daemon boot via {@link setAppDeployRunner}
 * (see apps-deploy-backend.ts), mirroring setContainerExecutorDeps — so this
 * module imports no `pg`/SSH and stays safe to load anywhere.
 */

import type { AppDeployRunner } from "./app-deploy-orchestrator";
import { appDeploymentsService } from "./app-deployments";
import type { ContainerJobsWriter } from "./container-job-service";
import { containerJobsWriter } from "./container-jobs-writer";
import { JOB_TYPES } from "./provisioning-job-types";

// ── runtime-injected executor (daemon side) ─────────────────────────────────
let appDeployRunner: AppDeployRunner | null = null;

/** Wire the node deploy runner the daemon runs for APP_DEPLOY jobs. */
export function setAppDeployRunner(runner: AppDeployRunner): void {
  appDeployRunner = runner;
}

/** Resolve the deploy runner, or throw if the backend isn't wired yet. */
export function getAppDeployRunner(): AppDeployRunner {
  if (!appDeployRunner) {
    throw new Error("App deploy runner not configured — call setAppDeployRunner()");
  }
  return appDeployRunner;
}

/** Extract the appId from an APP_DEPLOY job payload (throws if absent). */
export function readAppDeployJobData(job: { data: unknown }): { appId: string } {
  const data = (job.data ?? {}) as Record<string, unknown>;
  if (typeof data.appId !== "string" || data.appId.length === 0) {
    throw new Error("APP_DEPLOY job missing data.appId");
  }
  return { appId: data.appId };
}

/** Daemon: run the full deploy for a claimed APP_DEPLOY job via the injected runner. */
export async function dispatchAppDeployJob(job: { data: unknown }): Promise<void> {
  const { appId } = readAppDeployJobData(job);
  await getAppDeployRunner().run(appId);
}

// ── enqueue (Worker / request side) ─────────────────────────────────────────
/** Enqueue an APP_DEPLOY job (pg-free) over the shared job writer. */
export function enqueueAppDeploy(
  writer: ContainerJobsWriter,
  p: { appId: string; organizationId: string; userId?: string },
): Promise<{ id: string }> {
  return writer.insertJob({
    type: JOB_TYPES.APP_DEPLOY,
    organizationId: p.organizationId,
    userId: p.userId,
    data: { appId: p.appId },
  });
}

/**
 * Worker boot (Apps / Product 2): wire `appDeploymentsService.createDeployment`
 * to enqueue APP_DEPLOY over the shared (pg-free) job writer. Call once in
 * cloud-api boot — after this, hitting the deploy route enqueues the real
 * isolated deploy that the daemon runs. Safe to import on workerd (no `pg`).
 */
export function configureAppsDeployTrigger(): void {
  appDeploymentsService.setDeployEnqueuer((p) => enqueueAppDeploy(containerJobsWriter, p));
}
