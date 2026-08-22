/**
 * Disabled-first production entrypoint for the manifest-v3 backup catalogue.
 * The two gates are the only environment names read before the enabled
 * composition is dynamically imported, so disabled hosts cannot initialize
 * storage, KMS, database, provider, executor, or spool authorities.
 */

import type { AgentBackupCatalogRuntimeSummary } from "./agent-backup-catalog-runtime";

export interface AgentBackupCatalogWorkerComposition {
  readonly enabled: boolean;
  runCycle(signal?: AbortSignal): Promise<AgentBackupCatalogRuntimeSummary>;
}

export interface AgentBackupCatalogWorkerEnabledCompositionModule {
  createAgentBackupCatalogWorkerEnabledComposition(input: {
    env: NodeJS.ProcessEnv;
  }): Promise<AgentBackupCatalogWorkerComposition>;
}

export interface CreateAgentBackupCatalogWorkerCompositionOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam proving the disabled branch performs no enabled-module load. */
  loadEnabledComposition?: () => Promise<AgentBackupCatalogWorkerEnabledCompositionModule>;
}

function disabledSummary(): AgentBackupCatalogRuntimeSummary {
  return {
    enabled: false,
    scheduleEnrolled: 0,
    scheduleProtected: 0,
    scheduleRecycled: 0,
    scheduleClaimed: 0,
    scheduleReserved: 0,
    scheduleDeferred: 0,
    scheduleIndeterminate: 0,
    scheduleOverdue: 0,
    operationClaimed: 0,
    operationCaptured: 0,
    operationCaptureRetryScheduled: 0,
    operationCaptureTerminal: 0,
    operationProtected: 0,
    operationPublicationRetryScheduled: 0,
    operationDeferred: 0,
    operationIndeterminate: 0,
    spoolCleanup: {
      discovered: 0,
      authorized: 0,
      completed: 0,
      pending: 0,
      skippedUnprotected: 0,
      indeterminate: 0,
    },
    deletionCandidates: 0,
    deletionEnqueued: 0,
    deletionEnqueueIndeterminate: 0,
    gcClaimed: 0,
    gcCompleted: 0,
    gcFailed: 0,
    gcIndeterminate: 0,
    deletionFinalized: 0,
    deletionFinalizeIndeterminate: 0,
    alertCodes: [],
  };
}

/** Parse only the two gates; every other environment read belongs after this boundary. */
export function isAgentBackupCatalogWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const scheduleEnabled = env.AGENT_BACKUP_RPO_SCHEDULER_ENABLED === "1";
  if (env.AGENT_BACKUP_CATALOG_RUNTIME_ENABLED !== "1") {
    if (scheduleEnabled) {
      throw new Error(
        "AGENT_BACKUP_RPO_SCHEDULER_ENABLED requires AGENT_BACKUP_CATALOG_RUNTIME_ENABLED=1",
      );
    }
    return false;
  }
  return true;
}

/** Build one process-wide production composition, or a zero-authority disabled facade. */
export async function createAgentBackupCatalogWorkerComposition(
  options: CreateAgentBackupCatalogWorkerCompositionOptions = {},
): Promise<AgentBackupCatalogWorkerComposition> {
  const env = options.env ?? process.env;
  if (!isAgentBackupCatalogWorkerEnabled(env)) {
    return Object.freeze({
      enabled: false,
      async runCycle() {
        return disabledSummary();
      },
    });
  }
  const enabledModule = options.loadEnabledComposition
    ? await options.loadEnabledComposition()
    : await import("./agent-backup-catalog-worker-enabled-composition");
  return enabledModule.createAgentBackupCatalogWorkerEnabledComposition({ env });
}
