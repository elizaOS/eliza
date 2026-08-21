/**
 * Runs one bounded scheduler tick for the durable sandbox-backup catalogue.
 *
 * The caller owns cadence and logging. Production daemon composition is
 * intentionally absent until activation/vault authorities and a dedicated
 * sub-minute lane exist. This service owns feature-gated storage authority
 * resolution, fair operation leases, retry deferral for pipeline stages that
 * do not yet have an executor, and isolated exact-object GC. It never logs
 * credentials, endpoint URLs, object keys, or locators.
 */

import {
  type AgentBackupOperationClaim,
  type AgentBackupOperationExecution,
  claimDueAgentBackupOperations,
  failAgentBackupOperation,
  heartbeatAgentBackupOperation,
  transitionAgentBackupOperation,
} from "../../db/repositories/agent-backup-catalog";
import {
  type AgentBackupDeletionCandidate,
  type AgentBackupGcClaim,
  claimAgentBackupGc,
  enqueueAgentBackupDeletion,
  finalizeAgentBackupDeletion,
  listDueAgentBackupDeletions,
  listFinalizableAgentBackupDeletions,
} from "../../db/repositories/agent-backup-gc";
import {
  type AgentBackupScheduleClaim,
  claimDueAgentBackupSchedules,
  countOverdueAgentBackupSchedules,
  deferClaimedAgentBackupSchedule,
  enrollEligibleAgentBackupSchedules,
  reconcileAgentBackupSchedules,
  reserveClaimedAgentBackupSchedule,
} from "../../db/repositories/agent-backup-scheduler";
import type { AgentBackupCatalogState } from "../../db/schemas/agent-sandboxes";
import {
  type AgentBackupObjectStoreRegistry,
  type AgentBackupStorageEndpoint,
  createAgentBackupObjectStoreRegistry,
} from "../storage/agent-backup-object-store";
import type { RuntimeR2Bucket } from "../storage/r2-runtime-binding";
import { isTrustedAgentBackupCaptureV2TerminalDisposition } from "./agent-backup-capture-v2-failure-disposition";
import type {
  AgentBackupCaptureV3SpoolCleanupJanitor,
  AgentBackupCaptureV3SpoolCleanupSummary,
} from "./agent-backup-capture-v3-spool-cleanup";
import { executeAgentBackupGcClaims } from "./agent-backup-catalog-worker";

const MAX_OPERATION_BATCH = 100;
const MAX_SCHEDULE_BATCH = 100;
const MAX_GC_BATCH = 100;
const MAX_LEASE_MS = 5 * 60_000;
const MAX_OPERATION_RETRY_MS = 24 * 60 * 60_000;
const MAX_GC_RETRY_MS = 6 * 60 * 60_000;

// Start deliberately serial. Operators may raise the bounded override after
// observing provider quotas and memory pressure in their own deployment.
const DEFAULT_OPERATION_BATCH = 1;
const DEFAULT_SCHEDULE_BATCH = 32;
const DEFAULT_SCHEDULE_LEASE_MS = 2 * 60_000;
const DEFAULT_SCHEDULE_RETRY_MS = 30_000;
const DEFAULT_GC_BATCH = 32;
const DEFAULT_DELETION_BATCH = 32;
const DEFAULT_LEASE_MS = 4 * 60_000;
const DEFAULT_OPERATION_RETRY_BASE_MS = 60_000;
const DEFAULT_OPERATION_RETRY_MAX_MS = 6 * 60 * 60_000;
const DEFAULT_GC_RETRY_BASE_MS = 30_000;
const DEFAULT_GC_RETRY_MAX_MS = 30 * 60_000;

const OPERATION_UNAVAILABLE_CODE = "BACKUP_PIPELINE_STAGE_UNAVAILABLE";
const SCHEDULE_RETRY_CODE = "BACKUP_SCHEDULE_RESERVATION_RETRY";
const SCHEDULE_RECONCILE_CODE = "BACKUP_SCHEDULE_RECONCILE_REQUIRED";
const SCHEDULE_RPO_OVERDUE_CODE = "BACKUP_SCHEDULE_RPO_OVERDUE";
const OPERATION_CAPTURE_RETRY_CODE = "BACKUP_CAPTURE_V2_RETRY_SCHEDULED";
const OPERATION_CAPTURE_TERMINAL_CODE = "BACKUP_CAPTURE_V2_TERMINAL";
const OPERATION_PUBLICATION_RETRY_CODE = "BACKUP_PUBLICATION_RETRY_SCHEDULED";
const OPERATION_RECONCILE_CODE = "BACKUP_OPERATION_RECONCILE_REQUIRED";
const GC_RETRY_CODE = "BACKUP_GC_RETRY_SCHEDULED";
const GC_RECONCILE_CODE = "BACKUP_GC_RECONCILE_REQUIRED";
const DELETION_ENQUEUE_RECONCILE_CODE = "BACKUP_DELETION_ENQUEUE_RECONCILE_REQUIRED";
const DELETION_FINALIZE_RECONCILE_CODE = "BACKUP_DELETION_FINALIZE_RECONCILE_REQUIRED";
const SPOOL_CLEANUP_RECONCILE_CODE = "BACKUP_SPOOL_CLEANUP_RECONCILE_REQUIRED";

type RetryableOperationState = Exclude<
  AgentBackupCatalogState,
  "legacy_unmigrated" | "failed_retryable" | "failed_terminal" | "deleting" | "deleted"
>;

export interface AgentBackupCatalogRuntimeR2Binding {
  bucketBinding: RuntimeR2Bucket;
  /** Stable deployment/binding identity; never a credential. */
  bindingIdentity: string;
}

export type AgentBackupCatalogRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      ownerId: string;
      scheduleEnabled: boolean;
      scheduleBatchSize: number;
      scheduleLeaseMs: number;
      scheduleRetryMs: number;
      operationBatchSize: number;
      gcBatchSize: number;
      deletionBatchSize: number;
      operationLeaseMs: number;
      gcLeaseMs: number;
      operationRetryBaseMs: number;
      operationRetryMaxMs: number;
      gcRetryBaseMs: number;
      gcRetryMaxMs: number;
    };

export interface AgentBackupCatalogRuntimeSummary {
  enabled: boolean;
  scheduleEnrolled: number;
  scheduleProtected: number;
  scheduleRecycled: number;
  scheduleClaimed: number;
  scheduleReserved: number;
  scheduleDeferred: number;
  scheduleIndeterminate: number;
  /** Exact current DB-clock 15-minute RPO breaches lacking strict proof. */
  scheduleOverdue: number;
  operationClaimed: number;
  operationCaptured: number;
  operationCaptureRetryScheduled: number;
  operationCaptureTerminal: number;
  operationProtected: number;
  operationPublicationRetryScheduled: number;
  operationDeferred: number;
  operationIndeterminate: number;
  spoolCleanup: AgentBackupCaptureV3SpoolCleanupSummary;
  deletionCandidates: number;
  deletionEnqueued: number;
  deletionEnqueueIndeterminate: number;
  gcClaimed: number;
  gcCompleted: number;
  gcFailed: number;
  gcIndeterminate: number;
  deletionFinalized: number;
  deletionFinalizeIndeterminate: number;
  /** Bounded static codes safe for structured logs and alert aggregation. */
  alertCodes: readonly string[];
}

export interface AgentBackupCatalogRuntimeDependencies {
  enrollSchedules(params: { limit: number }): Promise<number>;
  reconcileSchedules(params: { limit: number }): Promise<{
    protected: number;
    recycled: number;
  }>;
  claimSchedules(params: {
    ownerId: string;
    limit: number;
    leaseMs: number;
  }): Promise<AgentBackupScheduleClaim[]>;
  reserveSchedule(params: { claim: AgentBackupScheduleClaim }): Promise<unknown>;
  deferSchedule(params: {
    claim: AgentBackupScheduleClaim;
    retryDelayMs: number;
    errorCode: string;
  }): Promise<boolean>;
  countOverdueSchedules(): Promise<number>;
  claimOperations(params: {
    ownerId: string;
    limit: number;
    leaseMs: number;
  }): Promise<AgentBackupOperationClaim[]>;
  heartbeatOperation(params: {
    organizationId: string;
    backupId: string;
    execution: AgentBackupOperationExecution;
    leaseMs: number;
  }): Promise<unknown>;
  transitionOperation: typeof transitionAgentBackupOperation;
  failOperation: typeof failAgentBackupOperation;
  listDueDeletions: typeof listDueAgentBackupDeletions;
  enqueueDeletion: typeof enqueueAgentBackupDeletion;
  claimGc(params: {
    ownerId: string;
    limit: number;
    leaseMs: number;
  }): Promise<AgentBackupGcClaim[]>;
  executeGcClaims: typeof executeAgentBackupGcClaims;
  listFinalizableDeletions: typeof listFinalizableAgentBackupDeletions;
  finalizeDeletion: typeof finalizeAgentBackupDeletion;
}

export interface AgentBackupCatalogRuntimeCaptureExecutor {
  execute(params: {
    /** Always normalized to an owned `capturing` operation. */
    claim: Readonly<AgentBackupOperationClaim>;
    leaseMs: number;
    signal?: AbortSignal;
  }): Promise<{ state: "captured-upload-pending" }>;
}

export type AgentBackupCatalogRuntimePublicationState =
  | "captured"
  | "uploading"
  | "primary_uploaded"
  | "primary_verified"
  | "secondary_pending";

export interface AgentBackupCatalogRuntimePublicationExecutor {
  execute(params: {
    claim: Readonly<AgentBackupOperationClaim>;
    leaseMs: number;
    signal?: AbortSignal;
  }): Promise<
    | { state: "protected" }
    | {
        state: "retryable-failure";
        expectedState: AgentBackupCatalogRuntimePublicationState;
        error: {
          code: "BACKUP_PRIMARY_PUBLICATION_RETRY" | "BACKUP_SECONDARY_REPLICATION_RETRY";
          message: string;
        };
      }
  >;
}

const DEFAULT_DEPENDENCIES: AgentBackupCatalogRuntimeDependencies = {
  enrollSchedules: enrollEligibleAgentBackupSchedules,
  reconcileSchedules: reconcileAgentBackupSchedules,
  claimSchedules: claimDueAgentBackupSchedules,
  reserveSchedule: reserveClaimedAgentBackupSchedule,
  deferSchedule: deferClaimedAgentBackupSchedule,
  countOverdueSchedules: countOverdueAgentBackupSchedules,
  claimOperations: claimDueAgentBackupOperations,
  heartbeatOperation: heartbeatAgentBackupOperation,
  transitionOperation: transitionAgentBackupOperation,
  failOperation: failAgentBackupOperation,
  listDueDeletions: listDueAgentBackupDeletions,
  enqueueDeletion: enqueueAgentBackupDeletion,
  claimGc: claimAgentBackupGc,
  executeGcClaims: executeAgentBackupGcClaims,
  listFinalizableDeletions: listFinalizableAgentBackupDeletions,
  finalizeDeletion: finalizeAgentBackupDeletion,
};

function readBoundedInteger(params: {
  env: NodeJS.ProcessEnv;
  name: string;
  fallback: number;
  min: number;
  max: number;
}): number {
  const raw = params.env[params.name];
  if (raw === undefined || raw === "") return params.fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${params.name} must be a canonical positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < params.min || value > params.max) {
    throw new Error(`${params.name} must be between ${params.min} and ${params.max}`);
  }
  return value;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim() !== value || value.includes("\0")) {
    throw new Error(
      `${name} must be explicitly configured when backup catalogue runtime is enabled`,
    );
  }
  return value;
}

/** Parse the fail-closed runtime gate without reading storage credentials while disabled. */
export function readAgentBackupCatalogRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentBackupCatalogRuntimeConfig {
  const scheduleEnabled = env.AGENT_BACKUP_RPO_SCHEDULER_ENABLED === "1";
  if (env.AGENT_BACKUP_CATALOG_RUNTIME_ENABLED !== "1") {
    if (scheduleEnabled) {
      throw new Error(
        "AGENT_BACKUP_RPO_SCHEDULER_ENABLED requires AGENT_BACKUP_CATALOG_RUNTIME_ENABLED=1",
      );
    }
    return { enabled: false };
  }

  const operationRetryBaseMs = readBoundedInteger({
    env,
    name: "AGENT_BACKUP_OPERATION_RETRY_BASE_MS",
    fallback: DEFAULT_OPERATION_RETRY_BASE_MS,
    min: 1,
    max: MAX_OPERATION_RETRY_MS,
  });
  const operationRetryMaxMs = readBoundedInteger({
    env,
    name: "AGENT_BACKUP_OPERATION_RETRY_MAX_MS",
    fallback: DEFAULT_OPERATION_RETRY_MAX_MS,
    min: 1,
    max: MAX_OPERATION_RETRY_MS,
  });
  const gcRetryBaseMs = readBoundedInteger({
    env,
    name: "AGENT_BACKUP_GC_RETRY_BASE_MS",
    fallback: DEFAULT_GC_RETRY_BASE_MS,
    min: 1,
    max: MAX_GC_RETRY_MS,
  });
  const gcRetryMaxMs = readBoundedInteger({
    env,
    name: "AGENT_BACKUP_GC_RETRY_MAX_MS",
    fallback: DEFAULT_GC_RETRY_MAX_MS,
    min: 1,
    max: MAX_GC_RETRY_MS,
  });
  if (operationRetryBaseMs > operationRetryMaxMs) {
    throw new Error("AGENT_BACKUP_OPERATION_RETRY_BASE_MS cannot exceed its retry maximum");
  }
  if (gcRetryBaseMs > gcRetryMaxMs) {
    throw new Error("AGENT_BACKUP_GC_RETRY_BASE_MS cannot exceed its retry maximum");
  }

  return {
    enabled: true,
    ownerId: requiredEnv(env, "AGENT_BACKUP_CATALOG_WORKER_ID"),
    scheduleEnabled,
    scheduleBatchSize: readBoundedInteger({
      env,
      name: "AGENT_BACKUP_SCHEDULE_BATCH_SIZE",
      fallback: DEFAULT_SCHEDULE_BATCH,
      min: 1,
      max: MAX_SCHEDULE_BATCH,
    }),
    scheduleLeaseMs: readBoundedInteger({
      env,
      name: "AGENT_BACKUP_SCHEDULE_LEASE_MS",
      fallback: DEFAULT_SCHEDULE_LEASE_MS,
      min: 1,
      max: MAX_LEASE_MS,
    }),
    scheduleRetryMs: readBoundedInteger({
      env,
      name: "AGENT_BACKUP_SCHEDULE_RETRY_MS",
      fallback: DEFAULT_SCHEDULE_RETRY_MS,
      min: 1,
      max: 5 * 60_000,
    }),
    operationBatchSize: readBoundedInteger({
      env,
      name: "AGENT_BACKUP_OPERATION_BATCH_SIZE",
      fallback: DEFAULT_OPERATION_BATCH,
      min: 1,
      max: MAX_OPERATION_BATCH,
    }),
    gcBatchSize: readBoundedInteger({
      env,
      name: "AGENT_BACKUP_GC_BATCH_SIZE",
      fallback: DEFAULT_GC_BATCH,
      min: 1,
      max: MAX_GC_BATCH,
    }),
    deletionBatchSize: readBoundedInteger({
      env,
      name: "AGENT_BACKUP_DELETION_BATCH_SIZE",
      fallback: DEFAULT_DELETION_BATCH,
      min: 1,
      max: MAX_GC_BATCH,
    }),
    operationLeaseMs: readBoundedInteger({
      env,
      name: "AGENT_BACKUP_OPERATION_LEASE_MS",
      fallback: DEFAULT_LEASE_MS,
      min: 1,
      max: MAX_LEASE_MS,
    }),
    gcLeaseMs: readBoundedInteger({
      env,
      name: "AGENT_BACKUP_GC_LEASE_MS",
      fallback: DEFAULT_LEASE_MS,
      min: 1,
      max: MAX_LEASE_MS,
    }),
    operationRetryBaseMs,
    operationRetryMaxMs,
    gcRetryBaseMs,
    gcRetryMaxMs,
  };
}

/**
 * Build the two immutable storage authorities required by the catalogue.
 * R2 may arrive as a native Worker binding or explicit S3 credentials; the
 * Hetzner secondary is always the S3-compatible Object Storage API.
 */
export async function createAgentBackupCatalogRegistryFromEnv(
  params: { env?: NodeJS.ProcessEnv; primaryR2Binding?: AgentBackupCatalogRuntimeR2Binding } = {},
): Promise<AgentBackupObjectStoreRegistry> {
  const env = params.env ?? process.env;
  const primaryBase = {
    provider: "cloudflare-r2" as const,
    endpointAlias: requiredEnv(env, "AGENT_BACKUP_R2_ENDPOINT_ALIAS"),
    accountIdentity: requiredEnv(env, "AGENT_BACKUP_R2_ACCOUNT_ID"),
    bucket: requiredEnv(env, "AGENT_BACKUP_R2_BUCKET"),
    region: requiredEnv(env, "AGENT_BACKUP_R2_REGION"),
  };
  const primary: AgentBackupStorageEndpoint = params.primaryR2Binding
    ? {
        ...primaryBase,
        transport: "worker-r2",
        bindingIdentity: params.primaryR2Binding.bindingIdentity,
        bucketBinding: params.primaryR2Binding.bucketBinding,
      }
    : {
        ...primaryBase,
        transport: "s3-compatible",
        endpoint: requiredEnv(env, "AGENT_BACKUP_R2_ENDPOINT"),
        accessKeyId: requiredEnv(env, "AGENT_BACKUP_R2_ACCESS_KEY_ID"),
        secretAccessKey: requiredEnv(env, "AGENT_BACKUP_R2_SECRET_ACCESS_KEY"),
      };
  const secondary: AgentBackupStorageEndpoint = {
    provider: "hetzner-object-storage",
    transport: "s3-compatible",
    endpointAlias: requiredEnv(env, "AGENT_BACKUP_HETZNER_ENDPOINT_ALIAS"),
    accountIdentity: requiredEnv(env, "AGENT_BACKUP_HETZNER_ACCOUNT_ID"),
    endpoint: requiredEnv(env, "AGENT_BACKUP_HETZNER_ENDPOINT"),
    bucket: requiredEnv(env, "AGENT_BACKUP_HETZNER_BUCKET"),
    region: requiredEnv(env, "AGENT_BACKUP_HETZNER_REGION"),
    accessKeyId: requiredEnv(env, "AGENT_BACKUP_HETZNER_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv(env, "AGENT_BACKUP_HETZNER_SECRET_ACCESS_KEY"),
  };
  return createAgentBackupObjectStoreRegistry([primary, secondary]);
}

/** Exponential retry with bounded symmetric jitter; always respects provider/repository caps. */
export function agentBackupCatalogRetryDelay(params: {
  attempt: number;
  baseMs: number;
  maxMs: number;
  random?: () => number;
}): number {
  const exponent = Math.max(0, Math.min(30, Math.trunc(params.attempt)));
  const capped = Math.min(params.maxMs, params.baseMs * 2 ** exponent);
  const random = params.random ?? Math.random;
  const sample = Math.min(1, Math.max(0, random()));
  const jitterFactor = 0.8 + sample * 0.4;
  return Math.max(1, Math.min(params.maxMs, Math.round(capped * jitterFactor)));
}

function isRetryableOperationState(
  state: AgentBackupCatalogState,
): state is RetryableOperationState {
  return ![
    "legacy_unmigrated",
    "failed_retryable",
    "failed_terminal",
    "deleting",
    "deleted",
  ].includes(state);
}

function claimIdentity(claim: AgentBackupOperationClaim): {
  organizationId: string;
  backupId: string;
  operationId: string;
  activationGeneration: string;
  lifecycleGeneration: string;
  lifecycleRevision: string;
} | null {
  const backup = claim.backup;
  if (
    !backup.catalog_organization_id ||
    !backup.backup_operation_id ||
    !backup.lifecycle_generation ||
    backup.lifecycle_revision === null
  ) {
    return null;
  }
  return {
    organizationId: backup.catalog_organization_id,
    backupId: backup.id,
    operationId: backup.backup_operation_id,
    activationGeneration: backup.lifecycle_generation,
    lifecycleGeneration: backup.lifecycle_generation,
    lifecycleRevision: backup.lifecycle_revision.toString(),
  };
}

async function deferUnsupportedOperation(params: {
  claim: AgentBackupOperationClaim;
  config: Extract<AgentBackupCatalogRuntimeConfig, { enabled: true }>;
  dependencies: AgentBackupCatalogRuntimeDependencies;
  random?: () => number;
}): Promise<boolean> {
  const identity = claimIdentity(params.claim);
  const initialState = params.claim.backup.catalog_state;
  if (!identity || !initialState) return false;
  const execution = {
    ownerId: params.claim.ownerId,
    generation: params.claim.generation,
  };
  await params.dependencies.heartbeatOperation({
    organizationId: identity.organizationId,
    backupId: identity.backupId,
    execution,
    leaseMs: params.config.operationLeaseMs,
  });

  let state = initialState;
  if (state === "failed_retryable") {
    const resumeState = params.claim.backup.catalog_resume_state;
    if (!resumeState || !isRetryableOperationState(resumeState)) return false;
    await params.dependencies.transitionOperation({
      ...identity,
      expectedState: "failed_retryable",
      to: resumeState,
      resumeState,
      execution,
    });
    state = resumeState;
  }
  if (!isRetryableOperationState(state)) return false;

  await params.dependencies.failOperation({
    ...identity,
    expectedState: state,
    terminal: false,
    error: {
      code: OPERATION_UNAVAILABLE_CODE,
      message:
        "Backup pipeline stage is not enabled on this runtime; work remains durable and retryable",
    },
    retryDelayMs: agentBackupCatalogRetryDelay({
      attempt: params.claim.backup.catalog_attempts,
      baseMs: params.config.operationRetryBaseMs,
      maxMs: params.config.operationRetryMaxMs,
      random: params.random,
    }),
    execution,
  });
  return true;
}

function isCaptureOperationClaim(claim: Readonly<AgentBackupOperationClaim>): boolean {
  const state = claim.backup.catalog_state;
  return (
    state === "scheduled" ||
    state === "capturing" ||
    (state === "failed_retryable" &&
      (claim.backup.catalog_resume_state === "scheduled" ||
        claim.backup.catalog_resume_state === "capturing"))
  );
}

interface CaptureFailureDisposition {
  terminal: boolean;
  terminalSpoolCleanup?: Parameters<
    AgentBackupCaptureV3SpoolCleanupJanitor["stageTerminalFailure"]
  >[0]["authority"];
}

function classifyCaptureFailure(error: unknown): CaptureFailureDisposition {
  if (!isTrustedAgentBackupCaptureV2TerminalDisposition(error)) return { terminal: false };
  return {
    terminal: true,
    terminalSpoolCleanup: error.terminalSpoolCleanup,
  };
}

function isPublicationOperationClaim(claim: Readonly<AgentBackupOperationClaim>): boolean {
  const state = claim.backup.catalog_state;
  return (
    state === "captured" ||
    state === "uploading" ||
    state === "primary_uploaded" ||
    state === "primary_verified" ||
    state === "secondary_pending" ||
    (state === "failed_retryable" &&
      (claim.backup.catalog_resume_state === "captured" ||
        claim.backup.catalog_resume_state === "uploading" ||
        claim.backup.catalog_resume_state === "primary_uploaded" ||
        claim.backup.catalog_resume_state === "primary_verified" ||
        claim.backup.catalog_resume_state === "secondary_pending"))
  );
}

async function normalizeCaptureOperationClaim(params: {
  claim: AgentBackupOperationClaim;
  dependencies: AgentBackupCatalogRuntimeDependencies;
}): Promise<AgentBackupOperationClaim> {
  const identity = claimIdentity(params.claim);
  if (!identity) throw new Error("Capture claim identity is incomplete");
  const execution = {
    ownerId: params.claim.ownerId,
    generation: params.claim.generation,
  };
  let backup = params.claim.backup;
  if (backup.catalog_state === "failed_retryable") {
    const resumeState = backup.catalog_resume_state;
    if (resumeState !== "scheduled" && resumeState !== "capturing") {
      throw new Error("Capture retry does not own a capture state");
    }
    backup = await params.dependencies.transitionOperation({
      ...identity,
      expectedState: "failed_retryable",
      to: resumeState,
      resumeState,
      execution,
    });
  }
  if (backup.catalog_state === "scheduled") {
    backup = await params.dependencies.transitionOperation({
      ...identity,
      expectedState: "scheduled",
      to: "capturing",
      execution,
    });
  }
  if (backup.catalog_state !== "capturing") {
    throw new Error("Capture claim could not be normalized to capturing");
  }
  return { ...params.claim, backup };
}

/** Run one bounded, non-looping scheduler/GC tick. */
export async function runAgentBackupCatalogRuntimeCycle(params: {
  config: AgentBackupCatalogRuntimeConfig;
  registry?: AgentBackupObjectStoreRegistry;
  dependencies?: AgentBackupCatalogRuntimeDependencies;
  captureExecutor?: AgentBackupCatalogRuntimeCaptureExecutor;
  publicationExecutor?: AgentBackupCatalogRuntimePublicationExecutor;
  /** Inject only on the capture node that owns the persistent spool StateDirectory. */
  spoolCleanupJanitor?: AgentBackupCaptureV3SpoolCleanupJanitor;
  random?: () => number;
  signal?: AbortSignal;
}): Promise<AgentBackupCatalogRuntimeSummary> {
  const summary: AgentBackupCatalogRuntimeSummary = {
    enabled: params.config.enabled,
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
  if (!params.config.enabled) return summary;
  if (!params.registry) {
    throw new Error("Backup catalogue runtime requires both configured storage authorities");
  }
  const throwIfAborted = (): void => params.signal?.throwIfAborted();
  throwIfAborted();

  const dependencies = params.dependencies ?? DEFAULT_DEPENDENCIES;
  const alertCodes = new Set<string>();
  const reconcileSchedules = async (): Promise<void> => {
    if (!params.config.enabled || !params.config.scheduleEnabled) return;
    try {
      const reconciled = await dependencies.reconcileSchedules({
        limit: params.config.scheduleBatchSize,
      });
      summary.scheduleProtected += reconciled.protected;
      summary.scheduleRecycled += reconciled.recycled;
    } catch {
      throwIfAborted();
      summary.scheduleIndeterminate += 1;
      alertCodes.add(SCHEDULE_RECONCILE_CODE);
    }
  };
  const countOverdueSchedules = async (): Promise<void> => {
    if (!params.config.enabled || !params.config.scheduleEnabled) return;
    try {
      summary.scheduleOverdue = await dependencies.countOverdueSchedules();
      if (summary.scheduleOverdue > 0) {
        alertCodes.add(SCHEDULE_RPO_OVERDUE_CODE);
      }
    } catch {
      throwIfAborted();
      summary.scheduleIndeterminate += 1;
      alertCodes.add(SCHEDULE_RECONCILE_CODE);
    }
  };

  if (params.config.scheduleEnabled) {
    throwIfAborted();
    await reconcileSchedules();
    try {
      summary.scheduleEnrolled = await dependencies.enrollSchedules({
        limit: params.config.scheduleBatchSize,
      });
    } catch {
      throwIfAborted();
      summary.scheduleIndeterminate += 1;
      alertCodes.add(SCHEDULE_RECONCILE_CODE);
    }

    let scheduleClaims: AgentBackupScheduleClaim[] = [];
    try {
      scheduleClaims = await dependencies.claimSchedules({
        ownerId: params.config.ownerId,
        limit: params.config.scheduleBatchSize,
        leaseMs: params.config.scheduleLeaseMs,
      });
      summary.scheduleClaimed = scheduleClaims.length;
    } catch {
      throwIfAborted();
      summary.scheduleIndeterminate += 1;
      alertCodes.add(SCHEDULE_RECONCILE_CODE);
    }
    for (const claim of scheduleClaims) {
      throwIfAborted();
      try {
        await dependencies.reserveSchedule({ claim });
        summary.scheduleReserved += 1;
      } catch {
        throwIfAborted();
        try {
          if (
            await dependencies.deferSchedule({
              claim,
              retryDelayMs: params.config.scheduleRetryMs,
              errorCode: SCHEDULE_RETRY_CODE,
            })
          ) {
            summary.scheduleDeferred += 1;
            alertCodes.add(SCHEDULE_RETRY_CODE);
          } else {
            summary.scheduleIndeterminate += 1;
            alertCodes.add(SCHEDULE_RECONCILE_CODE);
          }
        } catch {
          throwIfAborted();
          summary.scheduleIndeterminate += 1;
          alertCodes.add(SCHEDULE_RECONCILE_CODE);
        }
      }
    }
  }

  // Emit the strict RPO signal before unrelated catalogue/GC dependencies can
  // fail. A later pass refreshes it when this tick may have published proof.
  throwIfAborted();
  await countOverdueSchedules();

  let operationClaims: AgentBackupOperationClaim[] = [];
  throwIfAborted();
  try {
    operationClaims = await dependencies.claimOperations({
      ownerId: params.config.ownerId,
      limit: params.config.operationBatchSize,
      leaseMs: params.config.operationLeaseMs,
    });
    summary.operationClaimed = operationClaims.length;
  } catch (error) {
    throwIfAborted();
    if (!params.config.scheduleEnabled) throw error;
    summary.operationIndeterminate += 1;
    alertCodes.add(OPERATION_RECONCILE_CODE);
  }
  for (const claim of operationClaims) {
    throwIfAborted();
    if (params.captureExecutor && isCaptureOperationClaim(claim)) {
      let normalized: AgentBackupOperationClaim;
      try {
        normalized = await normalizeCaptureOperationClaim({ claim, dependencies });
      } catch {
        throwIfAborted();
        // A lost transition response is indeterminate. The exact lease/state
        // will reconcile on a later claim without running a second executor.
        summary.operationIndeterminate += 1;
        alertCodes.add(OPERATION_RECONCILE_CODE);
        continue;
      }
      try {
        const result = await params.captureExecutor.execute({
          claim: normalized,
          leaseMs: params.config.operationLeaseMs,
          signal: params.signal,
        });
        if (result.state !== "captured-upload-pending") {
          throw new Error("Capture executor crossed an unsupported publication boundary");
        }
        summary.operationCaptured += 1;
      } catch (error) {
        throwIfAborted();
        const identity = claimIdentity(normalized);
        if (!identity) {
          summary.operationIndeterminate += 1;
          alertCodes.add(OPERATION_RECONCILE_CODE);
          continue;
        }
        const disposition = classifyCaptureFailure(error);
        const terminal = disposition.terminal;
        if (terminal && disposition.terminalSpoolCleanup) {
          if (!params.spoolCleanupJanitor) {
            summary.operationIndeterminate += 1;
            summary.spoolCleanup.pending += 1;
            alertCodes.add(OPERATION_RECONCILE_CODE);
            alertCodes.add(SPOOL_CLEANUP_RECONCILE_CODE);
            continue;
          }
          try {
            await params.spoolCleanupJanitor.stageTerminalFailure({
              authority: disposition.terminalSpoolCleanup,
              terminalErrorCode: OPERATION_CAPTURE_TERMINAL_CODE,
            });
          } catch {
            throwIfAborted();
            // The non-authorizing local candidate is the crash bridge between
            // the terminal database CAS and cleanup. Never commit terminal when
            // that bridge is not durably confirmed.
            summary.operationIndeterminate += 1;
            summary.spoolCleanup.indeterminate += 1;
            alertCodes.add(OPERATION_RECONCILE_CODE);
            alertCodes.add(SPOOL_CLEANUP_RECONCILE_CODE);
            continue;
          }
        }
        try {
          await dependencies.failOperation({
            ...identity,
            expectedState: "capturing",
            terminal,
            error: {
              code: terminal ? OPERATION_CAPTURE_TERMINAL_CODE : OPERATION_CAPTURE_RETRY_CODE,
              message: terminal
                ? "Capture-v2 returned deterministic authority, format, or replay-conflict evidence"
                : "Capture-v2 did not reach a confirmed recordCaptured boundary; retry remains safe",
            },
            ...(terminal
              ? {}
              : {
                  retryDelayMs: agentBackupCatalogRetryDelay({
                    attempt: normalized.backup.catalog_attempts,
                    baseMs: params.config.operationRetryBaseMs,
                    maxMs: params.config.operationRetryMaxMs,
                    random: params.random,
                  }),
                }),
            execution: {
              ownerId: normalized.ownerId,
              generation: normalized.generation,
            },
          });
          if (terminal) {
            summary.operationCaptureTerminal += 1;
            alertCodes.add(OPERATION_CAPTURE_TERMINAL_CODE);
          } else {
            summary.operationCaptureRetryScheduled += 1;
            alertCodes.add(OPERATION_CAPTURE_RETRY_CODE);
          }
        } catch {
          throwIfAborted();
          // recordCaptured or the failure write may have committed before a lost
          // response. Never overwrite that ambiguity with a synthetic success.
          summary.operationIndeterminate += 1;
          alertCodes.add(OPERATION_RECONCILE_CODE);
        }
      }
      continue;
    }
    if (params.publicationExecutor && isPublicationOperationClaim(claim)) {
      try {
        const result = await params.publicationExecutor.execute({
          claim,
          leaseMs: params.config.operationLeaseMs,
          signal: params.signal,
        });
        if (result.state === "protected") {
          summary.operationProtected += 1;
          continue;
        }
        const identity = claimIdentity(claim);
        if (!identity) {
          summary.operationIndeterminate += 1;
          alertCodes.add(OPERATION_RECONCILE_CODE);
          continue;
        }
        await dependencies.failOperation({
          ...identity,
          expectedState: result.expectedState,
          terminal: false,
          error: result.error,
          retryDelayMs: agentBackupCatalogRetryDelay({
            attempt: claim.backup.catalog_attempts,
            baseMs: params.config.operationRetryBaseMs,
            maxMs: params.config.operationRetryMaxMs,
            random: params.random,
          }),
          execution: {
            ownerId: claim.ownerId,
            generation: claim.generation,
          },
        });
        summary.operationPublicationRetryScheduled += 1;
        alertCodes.add(OPERATION_PUBLICATION_RETRY_CODE);
      } catch {
        throwIfAborted();
        // A transition or retry write may have committed before response loss.
        // Leave the exact leased row for reconciliation rather than guessing.
        summary.operationIndeterminate += 1;
        alertCodes.add(OPERATION_RECONCILE_CODE);
      }
      continue;
    }
    try {
      if (
        await deferUnsupportedOperation({
          claim,
          config: params.config,
          dependencies,
          random: params.random,
        })
      ) {
        summary.operationDeferred += 1;
        alertCodes.add(OPERATION_UNAVAILABLE_CODE);
      } else {
        summary.operationIndeterminate += 1;
        alertCodes.add(OPERATION_RECONCILE_CODE);
      }
    } catch {
      throwIfAborted();
      // error-policy:J1 the daemon receives static aggregate evidence; the
      // durable lease/state is reconciled after expiry without leaking locator data.
      summary.operationIndeterminate += 1;
      alertCodes.add(OPERATION_RECONCILE_CODE);
    }
  }

  // A publication executor may have reached `protected` in this cycle. Run a
  // second bounded exact-proof pass so its DB-clock RPO deadline is visible
  // immediately; response-loss cases are picked up here as well.
  throwIfAborted();
  await reconcileSchedules();
  if (operationClaims.length > 0) await countOverdueSchedules();

  throwIfAborted();
  if (params.spoolCleanupJanitor) {
    try {
      const cleanup = await params.spoolCleanupJanitor.runCycle();
      summary.spoolCleanup = {
        discovered: summary.spoolCleanup.discovered + cleanup.discovered,
        authorized: summary.spoolCleanup.authorized + cleanup.authorized,
        completed: summary.spoolCleanup.completed + cleanup.completed,
        pending: summary.spoolCleanup.pending + cleanup.pending,
        skippedUnprotected: summary.spoolCleanup.skippedUnprotected + cleanup.skippedUnprotected,
        indeterminate: summary.spoolCleanup.indeterminate + cleanup.indeterminate,
      };
      if (summary.spoolCleanup.pending > 0 || summary.spoolCleanup.indeterminate > 0) {
        alertCodes.add(SPOOL_CLEANUP_RECONCILE_CODE);
      }
    } catch {
      throwIfAborted();
      summary.spoolCleanup.indeterminate += 1;
      alertCodes.add(SPOOL_CLEANUP_RECONCILE_CODE);
    }
  }

  let dueDeletions: AgentBackupDeletionCandidate[] = [];
  throwIfAborted();
  try {
    dueDeletions = await dependencies.listDueDeletions({
      limit: params.config.deletionBatchSize,
    });
    summary.deletionCandidates = dueDeletions.length;
  } catch (error) {
    throwIfAborted();
    if (!params.config.scheduleEnabled) throw error;
    summary.deletionEnqueueIndeterminate += 1;
    alertCodes.add(DELETION_ENQUEUE_RECONCILE_CODE);
  }
  for (const candidate of dueDeletions) {
    throwIfAborted();
    try {
      const result = await dependencies.enqueueDeletion(candidate);
      summary.deletionEnqueued += result.enqueued;
    } catch {
      throwIfAborted();
      // error-policy:J1 enqueue revalidates under lock; a stale or lost response
      // is retried from durable catalogue state without logging its locator.
      summary.deletionEnqueueIndeterminate += 1;
      alertCodes.add(DELETION_ENQUEUE_RECONCILE_CODE);
    }
  }

  let gcClaims: AgentBackupGcClaim[] = [];
  throwIfAborted();
  try {
    gcClaims = await dependencies.claimGc({
      ownerId: params.config.ownerId,
      limit: params.config.gcBatchSize,
      leaseMs: params.config.gcLeaseMs,
    });
    summary.gcClaimed = gcClaims.length;
  } catch (error) {
    throwIfAborted();
    if (!params.config.scheduleEnabled) throw error;
    summary.gcIndeterminate += 1;
    alertCodes.add(GC_RECONCILE_CODE);
  }
  for (const claim of gcClaims) {
    throwIfAborted();
    try {
      const result = await dependencies.executeGcClaims({
        claims: [claim],
        registry: params.registry,
        retryDelayMs: agentBackupCatalogRetryDelay({
          attempt: claim.outbox.attempts,
          baseMs: params.config.gcRetryBaseMs,
          maxMs: params.config.gcRetryMaxMs,
          random: params.random,
        }),
      });
      summary.gcCompleted += result.completed;
      summary.gcFailed += result.failed;
      if (result.failed > 0) alertCodes.add(GC_RETRY_CODE);
    } catch {
      throwIfAborted();
      // A lost settlement response is deliberately indeterminate: the durable
      // completed row wins, or the lease expires and the exact claim is retried.
      summary.gcIndeterminate += 1;
      alertCodes.add(GC_RECONCILE_CODE);
    }
  }

  let finalizable: AgentBackupDeletionCandidate[] = [];
  throwIfAborted();
  try {
    finalizable = await dependencies.listFinalizableDeletions({
      limit: params.config.deletionBatchSize,
    });
  } catch (error) {
    throwIfAborted();
    if (!params.config.scheduleEnabled) throw error;
    summary.deletionFinalizeIndeterminate += 1;
    alertCodes.add(DELETION_FINALIZE_RECONCILE_CODE);
  }
  for (const candidate of finalizable) {
    throwIfAborted();
    try {
      await dependencies.finalizeDeletion(candidate);
      summary.deletionFinalized += 1;
    } catch {
      throwIfAborted();
      // error-policy:J1 finalization is receipt/CAS guarded; an ambiguous
      // response is harmless and a later bounded tick reconciles the tombstone.
      summary.deletionFinalizeIndeterminate += 1;
      alertCodes.add(DELETION_FINALIZE_RECONCILE_CODE);
    }
  }
  summary.alertCodes = [...alertCodes].sort();
  return summary;
}

let cachedProcessRegistry:
  | { env: NodeJS.ProcessEnv; registry: AgentBackupObjectStoreRegistry }
  | undefined;

/** Environment-driven composition seam; no production daemon calls it in this slice. */
export async function runAgentBackupCatalogRuntimeCycleFromEnv(
  params: {
    env?: NodeJS.ProcessEnv;
    primaryR2Binding?: AgentBackupCatalogRuntimeR2Binding;
    captureExecutor?: AgentBackupCatalogRuntimeCaptureExecutor;
    publicationExecutor?: AgentBackupCatalogRuntimePublicationExecutor;
    /** Requires durable node/spool affinity; it is intentionally not inferred from env. */
    spoolCleanupJanitor?: AgentBackupCaptureV3SpoolCleanupJanitor;
    random?: () => number;
    signal?: AbortSignal;
  } = {},
): Promise<AgentBackupCatalogRuntimeSummary> {
  const env = params.env ?? process.env;
  const config = readAgentBackupCatalogRuntimeConfig(env);
  if (!config.enabled) return runAgentBackupCatalogRuntimeCycle({ config });
  const registry = params.primaryR2Binding
    ? await createAgentBackupCatalogRegistryFromEnv({
        env,
        primaryR2Binding: params.primaryR2Binding,
      })
    : cachedProcessRegistry?.env === env
      ? cachedProcessRegistry.registry
      : await createAgentBackupCatalogRegistryFromEnv({ env });
  if (!params.primaryR2Binding && cachedProcessRegistry?.env !== env) {
    cachedProcessRegistry = { env, registry };
  }
  return runAgentBackupCatalogRuntimeCycle({
    config,
    registry,
    captureExecutor: params.captureExecutor,
    publicationExecutor: params.publicationExecutor,
    spoolCleanupJanitor: params.spoolCleanupJanitor,
    random: params.random,
    signal: params.signal,
  });
}
