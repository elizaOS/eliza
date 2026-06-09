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
   * `<shortid>.<base>` -> `nodeHost:hostPort` right after the container is marked
   * running, and removes it on delete. add failures fail the deploy (so the user
   * retries rather than a silent 502); remove failures are swallowed (a reconciler
   * sweeps orphans). No-ops when unset (ingress not configured). `extraHostnames`
   * carries the app's verified custom domains, host-matched on the same route.
   */
  onRouteAdded?: (route: {
    hostname: string;
    extraHostnames?: string[];
    nodeHost: string;
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
  try {
    const result = await deps.provider.provision({
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
    // Register the ingress route so `<shortid>.<base>` reaches this container,
    // plus the app's verified custom domains (best-effort — a domain-lookup
    // failure must NOT fail the deploy; the app just keeps its wildcard host).
    // Inside the try: an add failure marks the container errored (no silent 502).
    const endpoint = deriveAppPublicUrl(containerId);
    if (endpoint && deps.onRouteAdded) {
      const extraHostnames = deps.listVerifiedAppHostnames
        ? await deps.listVerifiedAppHostnames(row.appId).catch(() => [] as string[])
        : [];
      await deps.onRouteAdded({
        hostname: endpoint.hostname,
        extraHostnames,
        nodeHost: result.nodeHost,
        hostPort: result.hostPort,
      });
    }
  } catch (error) {
    await deps.store.markError(containerId, error instanceof Error ? error.message : String(error));
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
    await deps.onRouteRemoved({ hostname: endpoint.hostname }).catch(() => undefined);
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
