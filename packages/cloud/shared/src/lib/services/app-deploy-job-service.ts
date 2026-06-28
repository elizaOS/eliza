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

import type { AppDeployRunner, AppDeployRunOptions } from "./app-deploy-orchestrator";
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

/** Extract deploy data from an APP_DEPLOY job payload (throws if malformed). */
export function readAppDeployJobData(job: { data: unknown }): {
  appId: string;
  options?: AppDeployRunOptions;
} {
  const data = (job.data ?? {}) as Record<string, unknown>;
  if (typeof data.appId !== "string" || data.appId.length === 0) {
    throw new Error("APP_DEPLOY job missing data.appId");
  }
  const options = parseDeployOptions(data.options);
  return options ? { appId: data.appId, options } : { appId: data.appId };
}

/** Daemon: run the full deploy for a claimed APP_DEPLOY job via the injected runner. */
export async function dispatchAppDeployJob(job: { data: unknown }): Promise<void> {
  const { appId, options } = readAppDeployJobData(job);
  await getAppDeployRunner().run(appId, options);
}

// ── enqueue (Worker / request side) ─────────────────────────────────────────
/** Enqueue an APP_DEPLOY job (pg-free) over the shared job writer. */
export function enqueueAppDeploy(
  writer: ContainerJobsWriter,
  p: { appId: string; organizationId: string; userId?: string; options?: AppDeployRunOptions },
): Promise<{ id: string }> {
  return writer.insertJob({
    type: JOB_TYPES.APP_DEPLOY,
    organizationId: p.organizationId,
    userId: p.userId,
    data: p.options ? { appId: p.appId, options: p.options } : { appId: p.appId },
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

function parseDeployOptions(value: unknown): AppDeployRunOptions | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("APP_DEPLOY job data.options must be an object when present");
  }
  const raw = value as Record<string, unknown>;
  const options: AppDeployRunOptions = {};

  for (const key of ["repoUrl", "ref", "dockerfile"] as const) {
    const next = raw[key];
    if (next !== undefined) {
      if (typeof next !== "string" || next.length === 0) {
        throw new Error(`APP_DEPLOY job data.options.${key} must be a non-empty string`);
      }
      options[key] = next;
    }
  }

  if (raw.env !== undefined) {
    if (typeof raw.env !== "object" || raw.env === null || Array.isArray(raw.env)) {
      throw new Error("APP_DEPLOY job data.options.env must be an object");
    }
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(raw.env)) {
      if (typeof val !== "string") {
        throw new Error("APP_DEPLOY job data.options.env values must be strings");
      }
      env[key] = val;
    }
    options.env = env;
  }

  return Object.keys(options).length > 0 ? options : undefined;
}
