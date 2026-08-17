/** Deterministic unit proofs for the bounded backup catalogue runtime tick. */

import { describe, expect, test } from "bun:test";
import type { AgentBackupOperationClaim } from "../../db/repositories/agent-backup-catalog";
import type { AgentBackupGcClaim } from "../../db/repositories/agent-backup-gc";
import type { AgentBackupObjectStoreRegistry } from "../storage/agent-backup-object-store";
import { normalizeAgentBackupCaptureV2TerminalFailure } from "./agent-backup-capture-v2-failure-disposition";
import { AgentBackupCaptureV2PipelineError } from "./agent-backup-capture-v2-pipeline";
import type { AgentBackupCaptureV3TerminalSpoolCleanupAuthority } from "./agent-backup-capture-v3-spool-cleanup";
import {
  type AgentBackupCatalogRuntimeConfig,
  type AgentBackupCatalogRuntimeDependencies,
  agentBackupCatalogRetryDelay,
  createAgentBackupCatalogRegistryFromEnv,
  readAgentBackupCatalogRuntimeConfig,
  runAgentBackupCatalogRuntimeCycle,
  runAgentBackupCatalogRuntimeCycleFromEnv,
} from "./agent-backup-catalog-runtime";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_ID = "00000000-0000-4000-8000-000000000007";
const BACKUP_ID = "00000000-0000-4000-8000-000000000002";
const OPERATION_ID = "00000000-0000-4000-8000-000000000003";
const LIFECYCLE_GENERATION = "00000000-0000-4000-8000-000000000004";
const CLAIM_GENERATION = "00000000-0000-4000-8000-000000000005";

function trustedTerminalCaptureFailure(
  code: string,
  terminalSpoolCleanup?: AgentBackupCaptureV3TerminalSpoolCleanupAuthority,
): Error {
  const disposition = normalizeAgentBackupCaptureV2TerminalFailure(
    new AgentBackupCaptureV2PipelineError(code, "deterministic capture rejection"),
    terminalSpoolCleanup,
  );
  if (!disposition) throw new Error(`Test terminal code ${code} is not in capture policy`);
  return disposition;
}

const ENABLED_CONFIG: Extract<AgentBackupCatalogRuntimeConfig, { enabled: true }> = {
  enabled: true,
  ownerId: "catalogue-worker-staging",
  scheduleEnabled: false,
  scheduleBatchSize: 32,
  scheduleLeaseMs: 120_000,
  scheduleRetryMs: 30_000,
  operationBatchSize: 8,
  gcBatchSize: 32,
  deletionBatchSize: 32,
  operationLeaseMs: 240_000,
  gcLeaseMs: 240_000,
  operationRetryBaseMs: 60_000,
  operationRetryMaxMs: 21_600_000,
  gcRetryBaseMs: 30_000,
  gcRetryMaxMs: 1_800_000,
};

function operationClaim(
  state: "scheduled" | "failed_retryable" = "scheduled",
): AgentBackupOperationClaim {
  return {
    ownerId: ENABLED_CONFIG.ownerId,
    generation: CLAIM_GENERATION,
    backup: {
      id: BACKUP_ID,
      catalog_organization_id: ORG_ID,
      catalog_agent_id: AGENT_ID,
      backup_operation_id: OPERATION_ID,
      lifecycle_generation: LIFECYCLE_GENERATION,
      lifecycle_revision: 7n,
      catalog_state: state,
      catalog_resume_state: state === "failed_retryable" ? "capturing" : null,
      catalog_attempts: 0,
    },
  } as AgentBackupOperationClaim;
}

function publicationClaim(
  state:
    | "captured"
    | "uploading"
    | "primary_uploaded"
    | "primary_verified"
    | "secondary_pending"
    | "failed_retryable",
  resumeState: "uploading" | "secondary_pending" | null = null,
): AgentBackupOperationClaim {
  const scheduled = operationClaim();
  return {
    ...scheduled,
    backup: {
      ...scheduled.backup,
      catalog_state: state,
      catalog_resume_state: state === "failed_retryable" ? resumeState : null,
    },
  };
}

function gcClaim(index: number): AgentBackupGcClaim {
  return {
    outbox: {
      id: `gc-${index}`,
      attempts: 1,
      claim_owner: ENABLED_CONFIG.ownerId,
      claim_generation: CLAIM_GENERATION,
    },
    object: {},
    multipart: null,
  } as AgentBackupGcClaim;
}

function dependencies(
  overrides: Partial<AgentBackupCatalogRuntimeDependencies> = {},
): AgentBackupCatalogRuntimeDependencies {
  return {
    enrollSchedules: async () => 0,
    reconcileSchedules: async () => ({ protected: 0, recycled: 0 }),
    claimSchedules: async () => [],
    reserveSchedule: async () => undefined,
    deferSchedule: async () => false,
    countOverdueSchedules: async () => 0,
    claimOperations: async () => [],
    heartbeatOperation: async () => undefined,
    transitionOperation: async () => {
      throw new Error("unexpected transition");
    },
    failOperation: async () => {
      throw new Error("unexpected failure writeback");
    },
    listDueDeletions: async () => [],
    enqueueDeletion: async () => {
      throw new Error("unexpected deletion enqueue");
    },
    claimGc: async () => [],
    executeGcClaims: async () => ({ completed: 0, failed: 0 }),
    listFinalizableDeletions: async () => [],
    finalizeDeletion: async () => {
      throw new Error("unexpected deletion finalization");
    },
    ...overrides,
  };
}

const UNUSED_REGISTRY = Object.freeze({}) as AgentBackupObjectStoreRegistry;

describe("agent backup catalogue runtime config", () => {
  test("gate off does not require or inspect storage configuration", async () => {
    expect(readAgentBackupCatalogRuntimeConfig({})).toEqual({ enabled: false });
    const summary = await runAgentBackupCatalogRuntimeCycleFromEnv({ env: {} });
    expect(summary).toEqual({
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
    });
  });

  test("gate on fails before claiming when explicit worker/storage authority is absent", async () => {
    expect(() =>
      readAgentBackupCatalogRuntimeConfig({ AGENT_BACKUP_CATALOG_RUNTIME_ENABLED: "1" }),
    ).toThrow("AGENT_BACKUP_CATALOG_WORKER_ID");

    await expect(
      runAgentBackupCatalogRuntimeCycleFromEnv({
        env: {
          AGENT_BACKUP_CATALOG_RUNTIME_ENABLED: "1",
          AGENT_BACKUP_CATALOG_WORKER_ID: "worker-1",
        },
      }),
    ).rejects.toThrow("AGENT_BACKUP_R2_ENDPOINT_ALIAS");
  });

  test("starts the operation dispatcher at one claim unless explicitly raised", () => {
    const config = readAgentBackupCatalogRuntimeConfig({
      AGENT_BACKUP_CATALOG_RUNTIME_ENABLED: "1",
      AGENT_BACKUP_CATALOG_WORKER_ID: "worker-1",
    });
    expect(config).toMatchObject({
      enabled: true,
      scheduleEnabled: false,
      scheduleBatchSize: 32,
      operationBatchSize: 1,
    });
  });

  test("keeps periodic admission off by default and rejects an orphaned schedule gate", () => {
    expect(() =>
      readAgentBackupCatalogRuntimeConfig({ AGENT_BACKUP_RPO_SCHEDULER_ENABLED: "1" }),
    ).toThrow("requires AGENT_BACKUP_CATALOG_RUNTIME_ENABLED=1");

    const config = readAgentBackupCatalogRuntimeConfig({
      AGENT_BACKUP_CATALOG_RUNTIME_ENABLED: "1",
      AGENT_BACKUP_RPO_SCHEDULER_ENABLED: "1",
      AGENT_BACKUP_CATALOG_WORKER_ID: "worker-1",
    });
    expect(config).toMatchObject({
      enabled: true,
      scheduleEnabled: true,
      scheduleBatchSize: 32,
      scheduleLeaseMs: 120_000,
      scheduleRetryMs: 30_000,
    });
  });

  test("builds explicit native-R2 primary and Hetzner S3 secondary authorities", async () => {
    const registry = await createAgentBackupCatalogRegistryFromEnv({
      env: {
        AGENT_BACKUP_R2_ENDPOINT_ALIAS: "r2-primary",
        AGENT_BACKUP_R2_ACCOUNT_ID: "cloudflare-account-a",
        AGENT_BACKUP_R2_BUCKET: "sandbox-backups-primary",
        AGENT_BACKUP_R2_REGION: "auto",
        AGENT_BACKUP_HETZNER_ENDPOINT_ALIAS: "hetzner-secondary",
        AGENT_BACKUP_HETZNER_ACCOUNT_ID: "hetzner-project-a",
        AGENT_BACKUP_HETZNER_ENDPOINT: "https://fsn1.your-objectstorage.com",
        AGENT_BACKUP_HETZNER_BUCKET: "sandbox-backups-secondary",
        AGENT_BACKUP_HETZNER_REGION: "fsn1",
        AGENT_BACKUP_HETZNER_ACCESS_KEY_ID: "access-id",
        AGENT_BACKUP_HETZNER_SECRET_ACCESS_KEY: "secret-value",
      },
      primaryR2Binding: {
        bindingIdentity: "cloud-api:BACKUP_R2:v1",
        bucketBinding: {
          async head() {
            return null;
          },
          async get() {
            return null;
          },
          async put() {
            return undefined;
          },
          async delete() {
            return undefined;
          },
        },
      },
    });

    expect(registry.forNewObject("r2-primary").authority).toMatchObject({
      provider: "cloudflare-r2",
      transport: "worker-r2",
      endpointAlias: "r2-primary",
      bucket: "sandbox-backups-primary",
    });
    expect(registry.forNewObject("hetzner-secondary").authority).toMatchObject({
      provider: "hetzner-object-storage",
      transport: "s3-compatible",
      endpointAlias: "hetzner-secondary",
      bucket: "sandbox-backups-secondary",
    });
  });

  test("builds the daemon's explicit S3-compatible R2 authority without provider I/O", async () => {
    const registry = await createAgentBackupCatalogRegistryFromEnv({
      env: {
        AGENT_BACKUP_R2_ENDPOINT_ALIAS: "r2-primary",
        AGENT_BACKUP_R2_ACCOUNT_ID: "cloudflare-account-a",
        AGENT_BACKUP_R2_ENDPOINT: "https://account-a.r2.cloudflarestorage.com",
        AGENT_BACKUP_R2_BUCKET: "sandbox-backups-primary",
        AGENT_BACKUP_R2_REGION: "auto",
        AGENT_BACKUP_R2_ACCESS_KEY_ID: "r2-access-id",
        AGENT_BACKUP_R2_SECRET_ACCESS_KEY: "r2-secret-value",
        AGENT_BACKUP_HETZNER_ENDPOINT_ALIAS: "hetzner-secondary",
        AGENT_BACKUP_HETZNER_ACCOUNT_ID: "hetzner-project-a",
        AGENT_BACKUP_HETZNER_ENDPOINT: "https://fsn1.your-objectstorage.com",
        AGENT_BACKUP_HETZNER_BUCKET: "sandbox-backups-secondary",
        AGENT_BACKUP_HETZNER_REGION: "fsn1",
        AGENT_BACKUP_HETZNER_ACCESS_KEY_ID: "hetzner-access-id",
        AGENT_BACKUP_HETZNER_SECRET_ACCESS_KEY: "hetzner-secret-value",
      },
    });

    expect(registry.forNewObject("r2-primary").authority).toMatchObject({
      provider: "cloudflare-r2",
      transport: "s3-compatible",
      endpointAlias: "r2-primary",
    });
  });

  test("uses bounded symmetric jitter without exceeding the retry cap", () => {
    expect(
      agentBackupCatalogRetryDelay({ attempt: 2, baseMs: 1_000, maxMs: 10_000, random: () => 0 }),
    ).toBe(3_200);
    expect(
      agentBackupCatalogRetryDelay({ attempt: 20, baseMs: 1_000, maxMs: 10_000, random: () => 1 }),
    ).toBe(10_000);
  });
});

describe("agent backup catalogue runtime scheduling", () => {
  test("admits a bounded fair schedule only behind its explicit feature gate", async () => {
    const calls: string[] = [];
    const scheduleClaim = {
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      operationId: OPERATION_ID,
      ownerId: ENABLED_CONFIG.ownerId,
      generation: CLAIM_GENERATION,
      expiresAt: new Date("2026-08-16T00:02:00.000Z"),
      dueAt: new Date("2026-08-16T00:00:00.000Z"),
      attempts: 1,
    };
    let reconcilePass = 0;
    const summary = await runAgentBackupCatalogRuntimeCycle({
      config: { ...ENABLED_CONFIG, scheduleEnabled: true },
      registry: UNUSED_REGISTRY,
      dependencies: dependencies({
        reconcileSchedules: async ({ limit }) => {
          calls.push(`reconcile:${limit}`);
          reconcilePass += 1;
          return reconcilePass === 1
            ? { protected: 1, recycled: 0 }
            : { protected: 1, recycled: 1 };
        },
        enrollSchedules: async ({ limit }) => {
          calls.push(`enroll:${limit}`);
          return 3;
        },
        claimSchedules: async ({ ownerId, limit, leaseMs }) => {
          calls.push(`claim:${ownerId}:${limit}:${leaseMs}`);
          return [scheduleClaim];
        },
        reserveSchedule: async ({ claim }) => {
          calls.push(`reserve:${claim.operationId}`);
        },
        claimOperations: async () => {
          calls.push("catalogue");
          return [];
        },
        countOverdueSchedules: async () => {
          calls.push("overdue");
          return 0;
        },
      }),
    });

    expect(calls).toEqual([
      "reconcile:32",
      "enroll:32",
      "claim:catalogue-worker-staging:32:120000",
      `reserve:${OPERATION_ID}`,
      "overdue",
      "catalogue",
      "reconcile:32",
    ]);
    expect(summary).toMatchObject({
      scheduleEnrolled: 3,
      scheduleProtected: 2,
      scheduleRecycled: 1,
      scheduleClaimed: 1,
      scheduleReserved: 1,
      scheduleDeferred: 0,
      scheduleIndeterminate: 0,
    });
  });

  test("alerts on the exact current DB-clock overdue count after reconciliation", async () => {
    const summary = await runAgentBackupCatalogRuntimeCycle({
      config: { ...ENABLED_CONFIG, scheduleEnabled: true },
      registry: UNUSED_REGISTRY,
      dependencies: dependencies({ countOverdueSchedules: async () => 7 }),
    });

    expect(summary.scheduleOverdue).toBe(7);
    expect(summary.alertCodes).toContain("BACKUP_SCHEDULE_RPO_OVERDUE");
  });

  test("preserves the RPO signal when unrelated catalogue and GC phases fail", async () => {
    const summary = await runAgentBackupCatalogRuntimeCycle({
      config: { ...ENABLED_CONFIG, scheduleEnabled: true },
      registry: UNUSED_REGISTRY,
      dependencies: dependencies({
        countOverdueSchedules: async () => 4,
        claimOperations: async () => {
          throw new Error("catalogue claim unavailable");
        },
        listDueDeletions: async () => {
          throw new Error("deletion scan unavailable");
        },
        claimGc: async () => {
          throw new Error("GC claim unavailable");
        },
        listFinalizableDeletions: async () => {
          throw new Error("finalization scan unavailable");
        },
      }),
    });

    expect(summary.scheduleOverdue).toBe(4);
    expect(summary.alertCodes).toEqual(
      expect.arrayContaining([
        "BACKUP_SCHEDULE_RPO_OVERDUE",
        "BACKUP_OPERATION_RECONCILE_REQUIRED",
        "BACKUP_DELETION_ENQUEUE_RECONCILE_REQUIRED",
        "BACKUP_GC_RECONCILE_REQUIRED",
        "BACKUP_DELETION_FINALIZE_RECONCILE_REQUIRED",
      ]),
    );
  });

  test("defers a failed admission without inventing success and fences response loss", async () => {
    const claims = [
      {
        organizationId: ORG_ID,
        agentId: AGENT_ID,
        operationId: OPERATION_ID,
        ownerId: ENABLED_CONFIG.ownerId,
        generation: CLAIM_GENERATION,
        expiresAt: new Date("2026-08-16T00:02:00.000Z"),
        dueAt: new Date("2026-08-16T00:00:00.000Z"),
        attempts: 1,
      },
      {
        organizationId: "00000000-0000-4000-8000-000000000010",
        agentId: "00000000-0000-4000-8000-000000000011",
        operationId: "00000000-0000-4000-8000-000000000012",
        ownerId: ENABLED_CONFIG.ownerId,
        generation: "00000000-0000-4000-8000-000000000013",
        expiresAt: new Date("2026-08-16T00:02:00.000Z"),
        dueAt: new Date("2026-08-16T00:00:00.000Z"),
        attempts: 1,
      },
    ];
    const deferred: string[] = [];
    const summary = await runAgentBackupCatalogRuntimeCycle({
      config: { ...ENABLED_CONFIG, scheduleEnabled: true },
      registry: UNUSED_REGISTRY,
      dependencies: dependencies({
        claimSchedules: async () => claims,
        reserveSchedule: async () => {
          throw new Error("reservation response unavailable");
        },
        deferSchedule: async ({ claim, retryDelayMs, errorCode }) => {
          deferred.push(`${claim.operationId}:${retryDelayMs}:${errorCode}`);
          return claim === claims[0];
        },
      }),
    });

    expect(deferred).toEqual([
      `${OPERATION_ID}:30000:BACKUP_SCHEDULE_RESERVATION_RETRY`,
      "00000000-0000-4000-8000-000000000012:30000:BACKUP_SCHEDULE_RESERVATION_RETRY",
    ]);
    expect(summary).toMatchObject({
      scheduleClaimed: 2,
      scheduleReserved: 0,
      scheduleDeferred: 1,
      scheduleIndeterminate: 1,
    });
    expect(summary.alertCodes).toEqual([
      "BACKUP_SCHEDULE_RECONCILE_REQUIRED",
      "BACKUP_SCHEDULE_RESERVATION_RETRY",
    ]);
  });

  test("normalizes an owned scheduled claim and runs only the capture-only executor", async () => {
    const claim = operationClaim();
    const calls: string[] = [];
    const summary = await runAgentBackupCatalogRuntimeCycle({
      config: ENABLED_CONFIG,
      registry: UNUSED_REGISTRY,
      dependencies: dependencies({
        claimOperations: async () => [claim],
        transitionOperation: async (params) => {
          calls.push(`${params.expectedState}->${params.to}`);
          return { ...claim.backup, catalog_state: params.to };
        },
      }),
      captureExecutor: {
        async execute({ claim: normalized, leaseMs }) {
          calls.push(`capture:${normalized.backup.catalog_state}:${leaseMs}`);
          return { state: "captured-upload-pending" };
        },
      },
    });

    expect(calls).toEqual(["scheduled->capturing", "capture:capturing:240000"]);
    expect(summary).toMatchObject({
      operationClaimed: 1,
      operationCaptured: 1,
      operationCaptureRetryScheduled: 0,
      operationDeferred: 0,
      operationIndeterminate: 0,
    });
  });

  test("records a bounded retry when capture fails before recordCaptured is confirmed", async () => {
    const claim = operationClaim();
    const calls: string[] = [];
    const summary = await runAgentBackupCatalogRuntimeCycle({
      config: ENABLED_CONFIG,
      registry: UNUSED_REGISTRY,
      random: () => 0.5,
      dependencies: dependencies({
        claimOperations: async () => [claim],
        transitionOperation: async (params) => ({
          ...claim.backup,
          catalog_state: params.to,
        }),
        failOperation: async (params) => {
          calls.push(`${params.expectedState}:${params.error.code}:${params.retryDelayMs}`);
          return claim.backup;
        },
      }),
      captureExecutor: {
        async execute() {
          throw new Error("capture transport closed");
        },
      },
    });

    expect(calls).toEqual(["capturing:BACKUP_CAPTURE_V2_RETRY_SCHEDULED:60000"]);
    expect(summary.operationCaptured).toBe(0);
    expect(summary.operationCaptureRetryScheduled).toBe(1);
    expect(summary.operationIndeterminate).toBe(0);
    expect(summary.alertCodes).toContain("BACKUP_CAPTURE_V2_RETRY_SCHEDULED");
  });

  for (const deterministicCode of [
    "AGENT_BACKUP_V3_INCREMENTAL_CAPTURE_UNSUPPORTED",
    "AGENT_BACKUP_V2_POSTGRES_UNSUPPORTED",
    "AGENT_BACKUP_V2_RUNTIME_ATTESTATION_CHANGED",
    "CAPTURE_V2_UNSUPPORTED_VERSION",
    "CAPTURE_V2_FRAME_TAMPERED",
    "AGENT_BACKUP_V2_SPOOL_REPLAY_CONFLICT",
    "AGENT_BACKUP_V2_PGLITE_PHYSICAL_BYTES_LIMIT",
    "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_ENTRY_LIMIT",
    "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN",
    "AGENT_BACKUP_V2_PGLITE_DUMP_EXCEEDS_PREFLIGHT",
    "AGENT_BACKUP_V2_PGLITE_DUMP_NOT_STREAMABLE",
    "AGENT_BACKUP_V2_PGLITE_MANAGED_DUMP_UNAVAILABLE",
    "AGENT_BACKUP_V2_PGLITE_DIRECTORY_UNATTESTED",
    "AGENT_BACKUP_V2_PGLITE_DIRECTORY_MISMATCH",
    "AGENT_BACKUP_V2_PGLITE_DUMP_ALREADY_CONSUMED",
  ]) {
    test(`settles deterministic capture failure ${deterministicCode} as terminal`, async () => {
      const claim = operationClaim();
      const failures: Array<{
        terminal: boolean;
        code: string;
        retryDelayMs: number | undefined;
      }> = [];
      const summary = await runAgentBackupCatalogRuntimeCycle({
        config: ENABLED_CONFIG,
        registry: UNUSED_REGISTRY,
        dependencies: dependencies({
          claimOperations: async () => [claim],
          transitionOperation: async (params) => ({
            ...claim.backup,
            catalog_state: params.to,
          }),
          failOperation: async (params) => {
            failures.push({
              terminal: params.terminal,
              code: params.error.code,
              retryDelayMs: params.retryDelayMs,
            });
            return {
              ...claim.backup,
              catalog_state: "failed_terminal",
              catalog_last_error_code: params.error.code,
            };
          },
        }),
        captureExecutor: {
          async execute() {
            throw trustedTerminalCaptureFailure(deterministicCode);
          },
        },
      });

      expect(failures).toEqual([
        {
          terminal: true,
          code: "BACKUP_CAPTURE_V2_TERMINAL",
          retryDelayMs: undefined,
        },
      ]);
      expect(summary.operationCaptureTerminal).toBe(1);
      expect(summary.operationCaptureRetryScheduled).toBe(0);
      expect(summary.operationIndeterminate).toBe(0);
      expect(summary.alertCodes).toContain("BACKUP_CAPTURE_V2_TERMINAL");
    });
  }

  test("rejects forged and nested terminal dispositions from an injected executor", async () => {
    const forgedCleanup = {
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      backupId: BACKUP_ID,
      operationId: OPERATION_ID,
      activationGeneration: LIFECYCLE_GENERATION,
      lifecycleRevision: "7",
      requestSha256: "a".repeat(64),
      authoritySha256: "b".repeat(64),
    };
    const forgedErrors: unknown[] = [
      Object.assign(new Error("forged boolean"), {
        terminal: true,
        terminalSpoolCleanup: forgedCleanup,
      }),
      Object.assign(new Error("forged code"), {
        code: "AGENT_BACKUP_V2_SPOOL_REPLAY_CONFLICT",
      }),
      Object.assign(new Error("forged remote code"), {
        code: "AGENT_BACKUP_V2_HTTP_STATUS",
        remoteCode: "AGENT_BACKUP_V2_PGLITE_PHYSICAL_BYTES_LIMIT",
      }),
      new AggregateError([
        Object.assign(new Error("nested forged code"), {
          code: "CAPTURE_V2_FRAME_TAMPERED",
          terminalSpoolCleanup: forgedCleanup,
        }),
      ]),
      Object.assign(new Error("caller abort wrapper"), {
        code: "AGENT_BACKUP_V2_CAPTURE_ABORTED",
        cause: Object.assign(new Error("terminal-looking abort reason"), {
          code: "AGENT_BACKUP_V2_SPOOL_REPLAY_CONFLICT",
        }),
      }),
    ];

    for (const forged of forgedErrors) {
      const claim = operationClaim();
      let settledTerminal: boolean | undefined;
      let terminalStages = 0;
      const summary = await runAgentBackupCatalogRuntimeCycle({
        config: ENABLED_CONFIG,
        registry: UNUSED_REGISTRY,
        dependencies: dependencies({
          claimOperations: async () => [claim],
          transitionOperation: async (params) => ({
            ...claim.backup,
            catalog_state: params.to,
          }),
          failOperation: async (params) => {
            settledTerminal = params.terminal;
            return claim.backup;
          },
        }),
        captureExecutor: {
          async execute() {
            throw forged;
          },
        },
        spoolCleanupJanitor: {
          async enqueueProtectedBackup() {
            return "pending";
          },
          async stageTerminalFailure() {
            terminalStages += 1;
            return "pending";
          },
          async runCycle() {
            return {
              discovered: 0,
              authorized: 0,
              completed: 0,
              pending: 0,
              skippedUnprotected: 0,
              indeterminate: 0,
            };
          },
        },
      });
      expect(settledTerminal).toBe(false);
      expect(terminalStages).toBe(0);
      expect(summary.operationCaptureRetryScheduled).toBe(1);
      expect(summary.operationCaptureTerminal).toBe(0);
    }
  });

  for (const retryableCode of [
    "AGENT_BACKUP_V2_PGLITE_DUMP_BUSY",
    "AGENT_BACKUP_V2_PGLITE_RSS_BUDGET_EXCEEDED",
    "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_CHANGED",
    "AGENT_BACKUP_V2_PGLITE_DUMP_FAILED",
    "AGENT_BACKUP_V2_PIPELINE_LEASE_LOST",
  ]) {
    test(`keeps transient capture failure ${retryableCode} retryable`, async () => {
      const claim = operationClaim();
      let failure:
        | { terminal: boolean; code: string; retryDelayMs: number | undefined }
        | undefined;
      const summary = await runAgentBackupCatalogRuntimeCycle({
        config: ENABLED_CONFIG,
        registry: UNUSED_REGISTRY,
        random: () => 0.5,
        dependencies: dependencies({
          claimOperations: async () => [claim],
          transitionOperation: async (params) => ({
            ...claim.backup,
            catalog_state: params.to,
          }),
          failOperation: async (params) => {
            failure = {
              terminal: params.terminal,
              code: params.error.code,
              retryDelayMs: params.retryDelayMs,
            };
            return claim.backup;
          },
        }),
        captureExecutor: {
          async execute() {
            throw Object.assign(new Error("transient capture rejection"), {
              code: "AGENT_BACKUP_V2_HTTP_STATUS",
              remoteCode: retryableCode,
            });
          },
        },
      });

      expect(failure).toEqual({
        terminal: false,
        code: "BACKUP_CAPTURE_V2_RETRY_SCHEDULED",
        retryDelayMs: 60_000,
      });
      expect(summary.operationCaptureRetryScheduled).toBe(1);
      expect(summary.operationCaptureTerminal).toBe(0);
    });
  }

  test("enqueues exact partial-spool cleanup only after terminal settlement is confirmed", async () => {
    const claim = operationClaim();
    const events: string[] = [];
    const terminalSpoolCleanup = {
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      backupId: BACKUP_ID,
      operationId: OPERATION_ID,
      activationGeneration: LIFECYCLE_GENERATION,
      lifecycleRevision: "7",
      requestSha256: "a".repeat(64),
      authoritySha256: "b".repeat(64),
    };
    const summary = await runAgentBackupCatalogRuntimeCycle({
      config: ENABLED_CONFIG,
      registry: UNUSED_REGISTRY,
      dependencies: dependencies({
        claimOperations: async () => [claim],
        transitionOperation: async (params) => ({
          ...claim.backup,
          catalog_state: params.to,
        }),
        failOperation: async (params) => {
          events.push(`settle:${params.terminal}:${params.error.code}`);
          return {
            ...claim.backup,
            catalog_version: 2,
            catalog_state: "failed_terminal",
            catalog_last_error_code: params.error.code,
            manifest_digest: null,
            object_inventory_digest: null,
          };
        },
      }),
      captureExecutor: {
        async execute() {
          events.push("capture");
          throw trustedTerminalCaptureFailure(
            "AGENT_BACKUP_V2_SPOOL_REPLAY_CONFLICT",
            terminalSpoolCleanup,
          );
        },
      },
      spoolCleanupJanitor: {
        async enqueueProtectedBackup() {
          throw new Error("Protected cleanup must not authorize a terminal partial spool");
        },
        async stageTerminalFailure(input) {
          events.push(`stage:${input.terminalErrorCode}:${input.authority.operationId}`);
          return "pending";
        },
        async runCycle() {
          events.push("cleanup");
          return {
            discovered: 1,
            authorized: 0,
            completed: 1,
            pending: 0,
            skippedUnprotected: 0,
            indeterminate: 0,
          };
        },
      },
    });

    expect(events).toEqual([
      "capture",
      `stage:BACKUP_CAPTURE_V2_TERMINAL:${OPERATION_ID}`,
      "settle:true:BACKUP_CAPTURE_V2_TERMINAL",
      "cleanup",
    ]);
    expect(summary.operationCaptureTerminal).toBe(1);
    expect(summary.spoolCleanup.completed).toBe(1);
    expect(summary.operationIndeterminate).toBe(0);
  });

  test("does not commit terminal when the pre-CAS cleanup candidate is not durable", async () => {
    const claim = operationClaim();
    let failureWrites = 0;
    const terminalSpoolCleanup = {
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      backupId: BACKUP_ID,
      operationId: OPERATION_ID,
      activationGeneration: LIFECYCLE_GENERATION,
      lifecycleRevision: "7",
      requestSha256: "a".repeat(64),
      authoritySha256: "b".repeat(64),
    };
    const summary = await runAgentBackupCatalogRuntimeCycle({
      config: ENABLED_CONFIG,
      registry: UNUSED_REGISTRY,
      dependencies: dependencies({
        claimOperations: async () => [claim],
        transitionOperation: async (params) => ({
          ...claim.backup,
          catalog_state: params.to,
        }),
        failOperation: async () => {
          failureWrites += 1;
          return claim.backup;
        },
      }),
      captureExecutor: {
        async execute() {
          throw trustedTerminalCaptureFailure(
            "AGENT_BACKUP_V2_SPOOL_REPLAY_CONFLICT",
            terminalSpoolCleanup,
          );
        },
      },
      spoolCleanupJanitor: {
        async enqueueProtectedBackup() {
          return "pending";
        },
        async stageTerminalFailure() {
          throw new Error("candidate fsync failed");
        },
        async runCycle() {
          return {
            discovered: 1,
            authorized: 0,
            completed: 0,
            pending: 0,
            skippedUnprotected: 1,
            indeterminate: 0,
          };
        },
      },
    });

    expect(failureWrites).toBe(0);
    expect(summary.operationCaptureTerminal).toBe(0);
    expect(summary.operationIndeterminate).toBe(1);
    expect(summary.spoolCleanup.indeterminate).toBe(1);
    expect(summary.alertCodes).toContain("BACKUP_SPOOL_CLEANUP_RECONCILE_REQUIRED");
  });

  test("stages terminal cleanup before a settlement response can be lost", async () => {
    const claim = operationClaim();
    let terminalStages = 0;
    const terminalSpoolCleanup = {
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      backupId: BACKUP_ID,
      operationId: OPERATION_ID,
      activationGeneration: LIFECYCLE_GENERATION,
      lifecycleRevision: "7",
      requestSha256: "a".repeat(64),
      authoritySha256: "b".repeat(64),
    };
    const summary = await runAgentBackupCatalogRuntimeCycle({
      config: ENABLED_CONFIG,
      registry: UNUSED_REGISTRY,
      dependencies: dependencies({
        claimOperations: async () => [claim],
        transitionOperation: async (params) => ({
          ...claim.backup,
          catalog_state: params.to,
        }),
        failOperation: async () => {
          throw new Error("terminal CAS committed but response was lost");
        },
      }),
      captureExecutor: {
        async execute() {
          throw trustedTerminalCaptureFailure(
            "AGENT_BACKUP_V2_SPOOL_REPLAY_CONFLICT",
            terminalSpoolCleanup,
          );
        },
      },
      spoolCleanupJanitor: {
        async enqueueProtectedBackup() {
          return "pending";
        },
        async stageTerminalFailure() {
          terminalStages += 1;
          return "pending";
        },
        async runCycle() {
          return {
            discovered: 1,
            authorized: 1,
            completed: 1,
            pending: 0,
            skippedUnprotected: 0,
            indeterminate: 0,
          };
        },
      },
    });

    expect(terminalStages).toBe(1);
    expect(summary.operationCaptureTerminal).toBe(0);
    expect(summary.operationIndeterminate).toBe(1);
    expect(summary.spoolCleanup).toMatchObject({ authorized: 1, completed: 1 });
    expect(summary.alertCodes).toContain("BACKUP_OPERATION_RECONCILE_REQUIRED");
  });

  test("heartbeats and durably defers an unsupported capture stage", async () => {
    const claim = operationClaim();
    const calls: string[] = [];
    let retryDelayMs = 0;
    const summary = await runAgentBackupCatalogRuntimeCycle({
      config: ENABLED_CONFIG,
      registry: UNUSED_REGISTRY,
      random: () => 0.5,
      dependencies: dependencies({
        claimOperations: async ({ limit }) => {
          calls.push(`claim:${limit}`);
          return [claim];
        },
        heartbeatOperation: async () => {
          calls.push("heartbeat");
        },
        failOperation: async (params) => {
          calls.push(`defer:${params.expectedState}:${params.error.code}`);
          retryDelayMs = params.retryDelayMs ?? 0;
          return claim.backup;
        },
      }),
    });

    expect(calls).toEqual([
      "claim:8",
      "heartbeat",
      "defer:scheduled:BACKUP_PIPELINE_STAGE_UNAVAILABLE",
    ]);
    expect(retryDelayMs).toBe(60_000);
    expect(summary.operationDeferred).toBe(1);
    expect(summary.operationIndeterminate).toBe(0);
    expect(summary.alertCodes).toContain("BACKUP_PIPELINE_STAGE_UNAVAILABLE");
  });

  test("resumes the exact failed state before writing the next retry", async () => {
    const claim = operationClaim("failed_retryable");
    const transitions: string[] = [];
    const summary = await runAgentBackupCatalogRuntimeCycle({
      config: ENABLED_CONFIG,
      registry: UNUSED_REGISTRY,
      dependencies: dependencies({
        claimOperations: async () => [claim],
        transitionOperation: async (params) => {
          transitions.push(`${params.expectedState}->${params.to}`);
          return { ...claim.backup, catalog_state: params.to };
        },
        failOperation: async (params) => {
          transitions.push(`${params.expectedState}->failed_retryable`);
          return claim.backup;
        },
      }),
    });

    expect(transitions).toEqual(["failed_retryable->capturing", "capturing->failed_retryable"]);
    expect(summary.operationDeferred).toBe(1);
  });

  test("dispatches post-capture work through protected without synthetic deferral", async () => {
    const owned = publicationClaim("captured");
    const calls: string[] = [];
    const summary = await runAgentBackupCatalogRuntimeCycle({
      config: ENABLED_CONFIG,
      registry: UNUSED_REGISTRY,
      dependencies: dependencies({ claimOperations: async () => [owned] }),
      publicationExecutor: {
        async execute({ claim, leaseMs }) {
          calls.push(`${claim.backup.catalog_state}:${leaseMs}`);
          return { state: "protected" };
        },
      },
    });

    expect(calls).toEqual(["captured:240000"]);
    expect(summary).toMatchObject({
      operationClaimed: 1,
      operationProtected: 1,
      operationPublicationRetryScheduled: 0,
      operationDeferred: 0,
      operationIndeterminate: 0,
    });
  });

  test("schedules an exact publication retry and continues past a poison claim", async () => {
    const retryable = publicationClaim("uploading");
    const healthy = publicationClaim("secondary_pending");
    healthy.backup.id = "00000000-0000-4000-8000-000000000008";
    const executed: string[] = [];
    const failures: string[] = [];
    const summary = await runAgentBackupCatalogRuntimeCycle({
      config: { ...ENABLED_CONFIG, operationBatchSize: 2 },
      registry: UNUSED_REGISTRY,
      random: () => 0.5,
      dependencies: dependencies({
        claimOperations: async () => [retryable, healthy],
        failOperation: async (input) => {
          failures.push(`${input.expectedState}:${input.error.code}:${input.retryDelayMs}`);
          return retryable.backup;
        },
      }),
      publicationExecutor: {
        async execute({ claim }) {
          executed.push(claim.backup.id);
          if (claim.backup.id === retryable.backup.id) {
            return {
              state: "retryable-failure",
              expectedState: "uploading",
              error: {
                code: "BACKUP_PRIMARY_PUBLICATION_RETRY",
                message: "Primary publication remains durably retryable",
              },
            };
          }
          return { state: "protected" };
        },
      },
    });

    expect(executed).toEqual([retryable.backup.id, healthy.backup.id]);
    expect(failures).toEqual(["uploading:BACKUP_PRIMARY_PUBLICATION_RETRY:60000"]);
    expect(summary).toMatchObject({
      operationClaimed: 2,
      operationProtected: 1,
      operationPublicationRetryScheduled: 1,
      operationIndeterminate: 0,
    });
    expect(summary.alertCodes).toContain("BACKUP_PUBLICATION_RETRY_SCHEDULED");
  });

  test("keeps transition and retry response loss indeterminate while preserving fairness", async () => {
    const responseLost = publicationClaim("uploading");
    const healthy = publicationClaim("secondary_pending");
    healthy.backup.id = "00000000-0000-4000-8000-000000000009";
    const summary = await runAgentBackupCatalogRuntimeCycle({
      config: { ...ENABLED_CONFIG, operationBatchSize: 2 },
      registry: UNUSED_REGISTRY,
      dependencies: dependencies({
        claimOperations: async () => [responseLost, healthy],
      }),
      publicationExecutor: {
        async execute({ claim }) {
          if (claim.backup.id === responseLost.backup.id) {
            throw new Error("transition committed but response was lost");
          }
          return { state: "protected" };
        },
      },
    });

    expect(summary).toMatchObject({
      operationClaimed: 2,
      operationProtected: 1,
      operationPublicationRetryScheduled: 0,
      operationIndeterminate: 1,
    });
    expect(summary.alertCodes).toContain("BACKUP_OPERATION_RECONCILE_REQUIRED");
  });

  test("runs protected spool reconciliation even after a lost publication response", async () => {
    const responseLost = publicationClaim("secondary_pending");
    let cleanupCycles = 0;
    const summary = await runAgentBackupCatalogRuntimeCycle({
      config: ENABLED_CONFIG,
      registry: UNUSED_REGISTRY,
      dependencies: dependencies({ claimOperations: async () => [responseLost] }),
      publicationExecutor: {
        async execute() {
          throw new Error("protected committed but transition response was lost");
        },
      },
      spoolCleanupJanitor: {
        async enqueueProtectedBackup() {
          return "pending";
        },
        async stageTerminalFailure() {
          return "pending";
        },
        async runCycle() {
          cleanupCycles += 1;
          return {
            discovered: 1,
            authorized: 1,
            completed: 1,
            pending: 0,
            skippedUnprotected: 0,
            indeterminate: 0,
          };
        },
      },
    });

    expect(cleanupCycles).toBe(1);
    expect(summary.operationIndeterminate).toBe(1);
    expect(summary.spoolCleanup).toMatchObject({ authorized: 1, completed: 1 });
    expect(summary.alertCodes).toContain("BACKUP_OPERATION_RECONCILE_REQUIRED");
  });

  test("does not let an indeterminate publication poison the next serial tick", async () => {
    const poison = publicationClaim("uploading");
    const healthy = publicationClaim("secondary_pending");
    healthy.backup.id = "00000000-0000-4000-8000-00000000000a";
    let cycle = 0;
    const claimedLimits: number[] = [];
    const runtimeDependencies = dependencies({
      claimOperations: async ({ limit }) => {
        claimedLimits.push(limit);
        return cycle++ === 0 ? [poison] : [healthy];
      },
    });
    const publicationExecutor = {
      async execute({ claim }: { claim: Readonly<AgentBackupOperationClaim> }) {
        if (claim.backup.id === poison.backup.id) {
          throw new Error("provider response is indeterminate");
        }
        return { state: "protected" as const };
      },
    };

    const poisoned = await runAgentBackupCatalogRuntimeCycle({
      config: { ...ENABLED_CONFIG, operationBatchSize: 1 },
      registry: UNUSED_REGISTRY,
      dependencies: runtimeDependencies,
      publicationExecutor,
    });
    const completed = await runAgentBackupCatalogRuntimeCycle({
      config: { ...ENABLED_CONFIG, operationBatchSize: 1 },
      registry: UNUSED_REGISTRY,
      dependencies: runtimeDependencies,
      publicationExecutor,
    });

    expect(claimedLimits).toEqual([1, 1]);
    expect(poisoned).toMatchObject({ operationIndeterminate: 1, operationProtected: 0 });
    expect(completed).toMatchObject({ operationIndeterminate: 0, operationProtected: 1 });
  });

  test("isolates one hundred poison claims and completes healthy work on the next bounded tick", async () => {
    const poisonClaims = Array.from({ length: 100 }, (_, index) => gcClaim(index));
    const healthyClaim = gcClaim(100);
    const attempted: string[] = [];
    let claimCycle = 0;
    const runtimeDependencies = dependencies({
      claimGc: async () => (claimCycle++ === 0 ? poisonClaims : [healthyClaim]),
      executeGcClaims: async ({ claims: [claim] }) => {
        const id = claim?.outbox.id ?? "missing";
        attempted.push(id);
        if (id !== "gc-100") {
          throw new Error("provider poison or lost settlement response");
        }
        return { completed: 1, failed: 0 };
      },
    });
    const boundedConfig = { ...ENABLED_CONFIG, gcBatchSize: 100 };
    const poisoned = await runAgentBackupCatalogRuntimeCycle({
      config: boundedConfig,
      registry: UNUSED_REGISTRY,
      dependencies: runtimeDependencies,
    });
    const healthy = await runAgentBackupCatalogRuntimeCycle({
      config: boundedConfig,
      registry: UNUSED_REGISTRY,
      dependencies: runtimeDependencies,
    });

    expect(attempted).toHaveLength(101);
    expect(attempted.at(-1)).toBe("gc-100");
    expect(poisoned).toMatchObject({
      gcClaimed: 100,
      gcCompleted: 0,
      gcFailed: 0,
      gcIndeterminate: 100,
    });
    expect(healthy).toMatchObject({
      gcClaimed: 1,
      gcCompleted: 1,
      gcFailed: 0,
      gcIndeterminate: 0,
    });
    expect(poisoned.alertCodes).toContain("BACKUP_GC_RECONCILE_REQUIRED");
  });

  test("preserves executor-scheduled GC retries as aggregate alerts", async () => {
    let retryDelayMs = 0;
    const summary = await runAgentBackupCatalogRuntimeCycle({
      config: ENABLED_CONFIG,
      registry: UNUSED_REGISTRY,
      random: () => 0.5,
      dependencies: dependencies({
        claimGc: async () => [gcClaim(1)],
        executeGcClaims: async (params) => {
          retryDelayMs = params.retryDelayMs;
          return { completed: 0, failed: 1 };
        },
      }),
    });

    expect(retryDelayMs).toBe(60_000);
    expect(summary.gcFailed).toBe(1);
    expect(summary.alertCodes).toContain("BACKUP_GC_RETRY_SCHEDULED");
  });

  test("enqueues due deletion before GC and finalizes only after receipted execution", async () => {
    const candidate = {
      organizationId: ORG_ID,
      backupId: BACKUP_ID,
      operationId: OPERATION_ID,
    };
    const order: string[] = [];
    const summary = await runAgentBackupCatalogRuntimeCycle({
      config: ENABLED_CONFIG,
      registry: UNUSED_REGISTRY,
      dependencies: dependencies({
        listDueDeletions: async ({ limit }) => {
          order.push(`list-due:${limit}`);
          return [candidate];
        },
        enqueueDeletion: async () => {
          order.push("enqueue");
          return { backup: operationClaim().backup, enqueued: 2 };
        },
        claimGc: async () => {
          order.push("claim-gc");
          return [gcClaim(1)];
        },
        executeGcClaims: async () => {
          order.push("execute-gc");
          return { completed: 1, failed: 0 };
        },
        listFinalizableDeletions: async ({ limit }) => {
          order.push(`list-finalizable:${limit}`);
          return [candidate];
        },
        finalizeDeletion: async () => {
          order.push("finalize");
          return operationClaim().backup;
        },
      }),
    });

    expect(order).toEqual([
      "list-due:32",
      "enqueue",
      "claim-gc",
      "execute-gc",
      "list-finalizable:32",
      "finalize",
    ]);
    expect(summary).toMatchObject({
      deletionCandidates: 1,
      deletionEnqueued: 2,
      deletionEnqueueIndeterminate: 0,
      gcCompleted: 1,
      deletionFinalized: 1,
      deletionFinalizeIndeterminate: 0,
    });
  });

  test("isolates lost enqueue/finalize responses without exposing candidate identity", async () => {
    const candidate = {
      organizationId: ORG_ID,
      backupId: BACKUP_ID,
      operationId: OPERATION_ID,
    };
    const summary = await runAgentBackupCatalogRuntimeCycle({
      config: ENABLED_CONFIG,
      registry: UNUSED_REGISTRY,
      dependencies: dependencies({
        listDueDeletions: async () => [candidate],
        enqueueDeletion: async () => {
          throw new Error("response lost after enqueue commit");
        },
        listFinalizableDeletions: async () => [candidate],
        finalizeDeletion: async () => {
          throw new Error("response lost after tombstone commit");
        },
      }),
    });

    expect(summary.deletionEnqueueIndeterminate).toBe(1);
    expect(summary.deletionFinalizeIndeterminate).toBe(1);
    expect(summary.alertCodes).toEqual([
      "BACKUP_DELETION_ENQUEUE_RECONCILE_REQUIRED",
      "BACKUP_DELETION_FINALIZE_RECONCILE_REQUIRED",
    ]);
  });
});
