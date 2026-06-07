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
import { buildContainerProvisionInput } from "./container-provider-input";
import {
  type JobLike,
  readContainerDeleteJobData,
  readContainerLogsJobData,
  readContainerProvisionJobData,
  readContainerRestartJobData,
} from "./container-jobs-data";

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
    info: { hostContainerId: string; hostPort: number; network: string },
  ): Promise<void>;
  markDeleted(containerId: string): Promise<void>;
  markError(containerId: string, error: string): Promise<void>;
}

export interface ContainerExecutorDeps {
  provider: AppContainerProvider;
  store: AppContainerStore;
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
    });
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
