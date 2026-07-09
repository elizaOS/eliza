/**
 * CONTAINER_* job executors (Apps / Product 2) — the per-type handlers the
 * provisioning daemon runs for app containers. Kept as a standalone, fully
 * dependency-injected module so the dispatch + state transitions are
 * unit-testable with fakes; the integration into `provisioning-jobs.ts` is a
 * thin set of `case JOB_TYPES.CONTAINER_*` arms that delegate here (appended,
 * never replacing the AGENT_* arms).
 *
 * Decoupled from 2AM's `containers` table: it reads/writes app container rows
 * through an injected {@link AppContainerStore}, so it never imports that schema
 * or repo directly.
 */

import { logger } from "../utils/logger";
import type { AppContainerProvider } from "./app-container-provider";
import { deriveAppPublicUrl } from "./app-url";
import {
  type JobLike,
  readContainerDeleteJobData,
  readContainerLogsJobData,
  readContainerProvisionJobData,
  readContainerRestartJobData,
  readContainerUpgradeJobData,
} from "./container-jobs-data";
import { buildContainerProvisionInput } from "./container-provider-input";

/** The fields an executor needs from an app container row. */
export interface AppContainerRow {
  id: string;
  appId: string;
  containerName: string;
  image: string;
  port: number;
  organizationId: string;
  userId: string;
  /** Caller env incl. the app's per-tenant DATABASE_URL (never the shared one). */
  environmentVars?: Record<string, string>;
}

/** Read/write seam for app container state (over the `containers` table). */
export interface AppContainerStore {
  getById(containerId: string): Promise<AppContainerRow | null>;
  markRunning(
    containerId: string,
    info: { hostContainerId: string; hostPort: number; network: string; nodeHost?: string },
  ): Promise<void>;
  markDeleted(containerId: string): Promise<void>;
  markError(containerId: string, error: string): Promise<void>;
}

export interface ContainerExecutorDeps {
  provider: AppContainerProvider;
  store: AppContainerStore;
  /**
   * Ingress hooks (optional). When set, the executor registers the per-app route
   * `<shortid>.<base>` -> `127.0.0.1:hostPort` (node-local Caddy) right after the
   * container is marked running, and removes it on delete. add failures fail the
   * deploy (so the user retries rather than a silent 502); remove failures are
   * swallowed (a reconciler sweeps orphans). No-ops when unset (ingress not
   * configured). `extraHostnames` carries the app's verified custom domains,
   * host-matched on the same route. The route dials loopback (Caddy is co-located
   * on the node), so the node host is not threaded through to the dial.
   */
  onRouteAdded?: (route: {
    hostname: string;
    extraHostnames?: string[];
    hostPort: number;
  }) => Promise<void>;
  onRouteRemoved?: (route: { hostname: string }) => Promise<void>;
  /**
   * Verified custom hostnames attached to an app (e.g. `elocute.fun`), folded
   * into the ingress route's host-match so the app also serves on its own
   * domain(s). Optional + best-effort: a lookup failure (or unset hook) just
   * means the app keeps only its `<shortid>.<base>` host — never fails a deploy.
   */
  listVerifiedAppHostnames?: (appId: string) => Promise<string[]>;
  /**
   * Flip the linked app to `deployed` (status + production_url + last_deployed_at)
   * once its container is running AND its ingress route is live. Without this the
   * deploy-status route echoes `building` forever — a successful deploy never
   * reaches READY (a stranded-looking app). No-op for non-app containers (the
   * impl resolves by app id). Optional/injected; best-effort is NOT acceptable
   * here — a failure must surface so the deploy is retried, not silently stuck.
   */
  markAppDeployed?: (appId: string, productionUrl: string | null) => Promise<void>;
  /**
   * Probe whether the app's public URL is HTTP-reachable (#9853). Runs after the
   * ingress route is registered and BEFORE the app is marked `deployed`, so a
   * deploy never reports success without a URL that actually answers. Returns
   * true once the URL completes an HTTP request (2xx/3xx/401/403), false on
   * connection-refused/timeout/502/504 — with bounded retries inside. Optional:
   * wired only alongside the ingress hooks (no ingress => no public route to
   * probe), so when unset the reachability gate is skipped (local dev).
   */
  probeAppReachable?: (url: string) => Promise<boolean>;
}

async function requireRow(store: AppContainerStore, containerId: string): Promise<AppContainerRow> {
  const row = await store.getById(containerId);
  if (!row) throw new Error(`App container ${containerId} not found`);
  return row;
}

export async function executeContainerProvision(
  job: JobLike,
  deps: ContainerExecutorDeps,
): Promise<void> {
  const { containerId } = readContainerProvisionJobData(job);
  const row = await requireRow(deps.store, containerId);
  const input = buildContainerProvisionInput({
    name: row.containerName,
    projectName: row.appId,
    organizationId: row.organizationId,
    userId: row.userId,
    image: row.image,
    port: row.port,
    environmentVars: row.environmentVars,
  });
  // PROVISION + markRunning: a failure HERE means no container is running, so the
  // row is a true provision failure -> markError (reapable/retryable). Only this
  // span is allowed to flip the row to `failed`.
  let result: Awaited<ReturnType<typeof deps.provider.provision>>;
  try {
    result = await deps.provider.provision({
      appId: row.appId,
      containerName: row.containerName,
      input,
    });
    await deps.store.markRunning(containerId, {
      hostContainerId: result.containerId,
      hostPort: result.hostPort,
      network: result.network,
      nodeHost: result.nodeHost,
    });
  } catch (error) {
    await deps.store.markError(containerId, error instanceof Error ? error.message : String(error));
    throw error;
  }

  // POST-markRunning: the container IS running. Registering the ingress route +
  // flipping the app to `deployed` are follow-up steps; a failure here must NOT
  // flip the row to `failed` (that would make a live, working container look
  // reapable). Leave the status `running` and let a reconciler or a redeploy
  // re-add the route. We rethrow so the job retries — but the row stays `running`.
  try {
    // Register the ingress route so `<shortid>.<base>` reaches this container,
    // plus the app's verified custom domains (best-effort — a domain-lookup
    // failure must NOT fail the deploy; the app just keeps its wildcard host).
    const endpoint = deriveAppPublicUrl(containerId);
    if (endpoint && deps.onRouteAdded) {
      const extraHostnames = deps.listVerifiedAppHostnames
        ? await deps.listVerifiedAppHostnames(row.appId).catch((error) => {
            // error-policy:J4 custom domains are additive; the primary app route stays explicit.
            logger.warn("[ContainerExecutor] custom-domain lookup failed during route-add", {
              containerId,
              appId: row.appId,
              error: error instanceof Error ? error.message : String(error),
            });
            return [] as string[];
          })
        : [];
      await deps.onRouteAdded({
        hostname: endpoint.hostname,
        extraHostnames,
        hostPort: result.hostPort,
      });
    }
    // Reachability gate (#9853): a deploy must NOT report success without a
    // public URL that actually answers. Once the route is registered, probe the
    // app's public URL; if it never becomes HTTP-reachable within the bounded
    // window, throw a clear error instead of marking `deployed`. The job then
    // retries and, on retry exhaustion, `provisioning-jobs` flips the app to
    // `failed` — so a phantom-success (live container, route added, app not
    // serving) surfaces as a failure rather than a stranded "deployed". The
    // container row stays `running` (it IS live; only the route isn't serving),
    // same as a route-add failure.
    if (endpoint && deps.probeAppReachable) {
      const reachable = await deps.probeAppReachable(endpoint.url);
      if (!reachable) {
        throw new Error(
          `App ${row.appId} container is running but its public URL ${endpoint.url} ` +
            "is not HTTP-reachable — refusing to report deploy success.",
        );
      }
    }
    // Container is running and routable — flip the app to `deployed` so the
    // deploy-status route reports READY (instead of `building` forever).
    if (deps.markAppDeployed) {
      await deps.markAppDeployed(row.appId, endpoint?.url ?? null);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[ContainerExecutor] route-add/markAppDeployed failed after markRunning", {
      containerId,
      appId: row.appId,
      error: message,
    });
    // Rethrow to retry the job — but the container row stays `running`, never
    // `failed` (it is a live container; only the post-provision wiring failed).
    throw error;
  }
}

export async function executeContainerDelete(
  job: JobLike,
  deps: ContainerExecutorDeps,
): Promise<void> {
  const { containerId } = readContainerDeleteJobData(job);
  const row = await deps.store.getById(containerId);
  if (row) await deps.provider.delete(row.containerName);
  // Remove the ingress route (best-effort; a reconciler sweeps any orphan).
  const endpoint = deriveAppPublicUrl(containerId);
  if (endpoint && deps.onRouteRemoved) {
    await deps.onRouteRemoved({ hostname: endpoint.hostname }).catch((error) => {
      // error-policy:J6 route removal is teardown best-effort; reconciler sweeps orphans.
      logger.warn("[ContainerExecutor] route removal failed during container delete", {
        containerId,
        hostname: endpoint.hostname,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  await deps.store.markDeleted(containerId);
}

export async function executeContainerRestart(
  job: JobLike,
  deps: ContainerExecutorDeps,
): Promise<void> {
  const { containerId } = readContainerRestartJobData(job);
  const row = await requireRow(deps.store, containerId);
  await deps.provider.restart(row.containerName);
}

export async function executeContainerLogs(
  job: JobLike,
  deps: ContainerExecutorDeps,
): Promise<string> {
  const data = readContainerLogsJobData(job);
  const row = await requireRow(deps.store, data.containerId);
  return deps.provider.logs(row.containerName, data.tail);
}

/**
 * Re-deploy a container onto a (possibly new) image: best-effort remove the old
 * container, then provision afresh and mark running. Brief downtime; blue/green
 * is a later refinement.
 */
export async function executeContainerUpgrade(
  job: JobLike,
  deps: ContainerExecutorDeps,
): Promise<void> {
  const data = readContainerUpgradeJobData(job);
  const row = await requireRow(deps.store, data.containerId);
  await deps.provider.delete(row.containerName).catch(() => {
    // old container may already be gone; provisioning replaces it regardless
  });
  const input = buildContainerProvisionInput({
    name: row.containerName,
    projectName: row.appId,
    organizationId: row.organizationId,
    userId: row.userId,
    image: data.image ?? row.image,
    port: row.port,
    environmentVars: row.environmentVars,
  });
  try {
    const result = await deps.provider.provision({
      appId: row.appId,
      containerName: row.containerName,
      input,
    });
    await deps.store.markRunning(data.containerId, {
      hostContainerId: result.containerId,
      hostPort: result.hostPort,
      network: result.network,
    });
  } catch (error) {
    await deps.store.markError(
      data.containerId,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}
