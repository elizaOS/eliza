/**
 * Disabled-first production entrypoint for the manifest-v3 backup catalogue.
 * The runtime, scheduler, and deletion-authority gates are the only environment
 * names read before the enabled composition is dynamically imported, so a
 * fully disabled host cannot initialize storage, KMS, database, provider,
 * executor, or spool authorities.
 */

import type {
  AccountDeletionBackupAuthority,
  AccountDeletionSpoolAuthority,
} from "./account-deletion-provider-adapters";
import type { AgentBackupCatalogRuntimeSummary } from "./agent-backup-catalog-runtime";

export interface AgentBackupCatalogWorkerComposition {
  readonly enabled: boolean;
  readonly accountDeletionAuthorities?: Readonly<{
    backup: AccountDeletionBackupAuthority;
    spool: AccountDeletionSpoolAuthority;
  }>;
  runCycle(signal?: AbortSignal): Promise<AgentBackupCatalogRuntimeSummary>;
}

/** Closed names for the cycle stages a daemon may report without values. */
export type AgentBackupCatalogCycleStage =
  | "catalog-runtime"
  | "account-deletion-authority"
  | "restore-coordinator";

const CYCLE_STAGES: ReadonlySet<string> = new Set<AgentBackupCatalogCycleStage>([
  "catalog-runtime",
  "account-deletion-authority",
  "restore-coordinator",
]);

/**
 * Attributes a cycle failure to one closed stage name. The original failure is
 * retained only as `cause`; the message never reflects its text.
 */
export class AgentBackupCatalogCycleStageError extends Error {
  readonly stage: AgentBackupCatalogCycleStage;

  constructor(stage: AgentBackupCatalogCycleStage, cause: unknown) {
    super(`Backup catalogue ${stage} stage failed`, { cause });
    this.name = "AgentBackupCatalogCycleStageError";
    this.stage = stage;
  }
}

/**
 * Value-free failure classification: stage, error class names, stable
 * machine codes (SQLSTATE, Node/TLS, typed application codes), and an HTTP
 * status. Messages, queries, parameters, hosts, buckets, keys, and provider
 * text are never read.
 */
export interface AgentBackupCatalogCycleFailureDiagnostic {
  stage: AgentBackupCatalogCycleStage | "unclassified";
  errorClasses: readonly string[];
  codes: readonly string[];
  httpStatus: number | null;
}

const MAX_DIAGNOSTIC_CAUSE_DEPTH = 8;
const DIAGNOSTIC_CLASS_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const DIAGNOSTIC_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_]{1,63}$/;

function ownDataValue(value: unknown, property: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    // error-policy:J1 hostile thrown values (e.g. revoked proxies) become
    // absent metadata; getters are never invoked.
    return undefined;
  }
}

function diagnosticClassName(value: unknown): string {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return "NonErrorValue";
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    const constructor = ownDataValue(prototype, "constructor");
    const name = ownDataValue(constructor, "name");
    return typeof name === "string" && DIAGNOSTIC_CLASS_PATTERN.test(name) ? name : "Unnamed";
  } catch {
    // error-policy:J1 an unreadable prototype is reported as a closed label.
    return "Unnamed";
  }
}

function diagnosticHttpStatus(value: unknown): number | null {
  const candidates = [
    ownDataValue(ownDataValue(value, "$metadata"), "httpStatusCode"),
    ownDataValue(value, "statusCode"),
  ];
  for (const candidate of candidates) {
    if (
      typeof candidate === "number" &&
      Number.isInteger(candidate) &&
      candidate >= 100 &&
      candidate <= 599
    ) {
      return candidate;
    }
  }
  return null;
}

/** Classify a cycle failure without reflecting any message or provider value. */
export function agentBackupCatalogCycleFailureDiagnostic(
  error: unknown,
): AgentBackupCatalogCycleFailureDiagnostic {
  let stage: AgentBackupCatalogCycleFailureDiagnostic["stage"] = "unclassified";
  const errorClasses: string[] = [];
  const codes: string[] = [];
  let httpStatus: number | null = null;
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_DIAGNOSTIC_CAUSE_DEPTH; depth += 1) {
    if (current === undefined || current === null || seen.has(current)) break;
    seen.add(current);
    errorClasses.push(diagnosticClassName(current));
    const candidateStage = ownDataValue(current, "stage");
    if (
      stage === "unclassified" &&
      typeof candidateStage === "string" &&
      CYCLE_STAGES.has(candidateStage)
    ) {
      stage = candidateStage as AgentBackupCatalogCycleStage;
    }
    const code = ownDataValue(current, "code");
    if (typeof code === "string" && DIAGNOSTIC_CODE_PATTERN.test(code) && !codes.includes(code)) {
      codes.push(code);
    }
    httpStatus ??= diagnosticHttpStatus(current);
    current = ownDataValue(current, "cause");
  }
  return Object.freeze({
    stage,
    errorClasses: Object.freeze(errorClasses),
    codes: Object.freeze(codes),
    httpStatus,
  });
}

/** Run one stage, attributing any failure to its closed stage name. */
export async function runAgentBackupCatalogCycleStage<T>(
  stage: AgentBackupCatalogCycleStage,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // error-policy:J1 fail closed: rethrow with the original failure as cause
    // so the daemon boundary can report which stage failed.
    throw new AgentBackupCatalogCycleStageError(stage, error);
  }
}

export interface AgentBackupCatalogWorkerEnabledCompositionModule {
  createAgentBackupCatalogWorkerEnabledComposition(input: {
    env: NodeJS.ProcessEnv;
  }): Promise<AgentBackupCatalogWorkerComposition>;
  createAccountDeletionBackupAuthorityComposition(input: {
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

/** Parse only the three gates; every other environment read belongs after this boundary. */
export function isAgentBackupCatalogWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const scheduleEnabled = env.AGENT_BACKUP_RPO_SCHEDULER_ENABLED === "1";
  const runtimeEnabled = env.AGENT_BACKUP_CATALOG_RUNTIME_ENABLED === "1";
  const deletionAuthorityEnabled = env.ACCOUNT_DELETION_BACKUP_AUTHORITY_ENABLED === "1";
  if (!runtimeEnabled) {
    if (scheduleEnabled) {
      throw new Error(
        "AGENT_BACKUP_RPO_SCHEDULER_ENABLED requires AGENT_BACKUP_CATALOG_RUNTIME_ENABLED=1",
      );
    }
  }
  return runtimeEnabled || deletionAuthorityEnabled;
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
  if (env.AGENT_BACKUP_CATALOG_RUNTIME_ENABLED !== "1") {
    return enabledModule.createAccountDeletionBackupAuthorityComposition({ env });
  }
  return enabledModule.createAgentBackupCatalogWorkerEnabledComposition({ env });
}
