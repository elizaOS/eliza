/** Production-composition contracts for the disabled manifest-v3 worker. */

import { describe, expect, mock, test } from "bun:test";
import {
  createAgentBackupCatalogWorkerComposition,
  isAgentBackupCatalogWorkerEnabled,
} from "./agent-backup-catalog-worker-composition";
import {
  createAgentBackupCatalogWorkerEnabledComposition,
  readAgentBackupCatalogWorkerEnabledConfig,
} from "./agent-backup-catalog-worker-enabled-composition";

function enabledEnv(): NodeJS.ProcessEnv {
  return {
    AGENT_BACKUP_CATALOG_RUNTIME_ENABLED: "1",
    AGENT_BACKUP_RPO_SCHEDULER_ENABLED: "0",
    AGENT_BACKUP_CATALOG_WORKER_ID: "catalog-worker-1",
    DATABASE_URL: "postgresql://backup-worker:secret@database.example.test/eliza",
    SECRETS_MASTER_KEY: "a".repeat(64),
    AGENT_BACKUP_R2_ENDPOINT_ALIAS: "r2-primary",
    AGENT_BACKUP_R2_ACCOUNT_ID: "r2-account",
    AGENT_BACKUP_R2_BUCKET: "r2-bucket",
    AGENT_BACKUP_R2_REGION: "auto",
    AGENT_BACKUP_R2_ENDPOINT: "https://r2.example.test",
    AGENT_BACKUP_R2_ACCESS_KEY_ID: "r2-access",
    AGENT_BACKUP_R2_SECRET_ACCESS_KEY: "r2-secret",
    AGENT_BACKUP_HETZNER_ENDPOINT_ALIAS: "hetzner-secondary",
    AGENT_BACKUP_HETZNER_ACCOUNT_ID: "hetzner-account",
    AGENT_BACKUP_HETZNER_ENDPOINT: "https://object-storage.example.test",
    AGENT_BACKUP_HETZNER_BUCKET: "hetzner-bucket",
    AGENT_BACKUP_HETZNER_REGION: "fsn1",
    AGENT_BACKUP_HETZNER_ACCESS_KEY_ID: "hetzner-access",
    AGENT_BACKUP_HETZNER_SECRET_ACCESS_KEY: "hetzner-secret",
    AGENT_BACKUP_SPOOL_STATE_DIRECTORY: "/var/lib/eliza-backup-catalog/spool",
    AGENT_BACKUP_SPOOL_MAX_BYTES: String(8 * 1024 ** 3),
    AGENT_BACKUP_SPOOL_MIN_FREE_BYTES: String(1024 ** 3),
    AGENT_BACKUP_SPOOL_CLEANUP_BATCH_SIZE: "32",
    AGENT_BACKUP_CAPTURE_DEADLINE_MS: "60000",
    AGENT_BACKUP_OBJECT_TRANSFER_DEADLINE_MS: "60000",
    AGENT_BACKUP_STORAGE_SCOPE: "production-eu",
    AGENT_BACKUP_AGENT_SCHEMA_VERSION: "2.0.0",
    AGENT_BACKUP_DATABASE_SCHEMA_VERSION: "238",
    AGENT_BACKUP_RUNTIME_PLUGINS_JSON: JSON.stringify([
      { id: "@elizaos/plugin-sql", version: "2.0.0" },
    ]),
    AGENT_BACKUP_LEGACY_WRITER_DRAIN_DEPLOYMENT_ID: "deploy-23844",
    AGENT_BACKUP_LEGACY_WRITER_DRAINED_AT: "2026-08-21T00:00:00.000Z",
    AGENT_BACKUP_STEWARD_KMS_BASE_URL: "https://steward.example.test",
    AGENT_BACKUP_STEWARD_KMS_TOKEN: "kms-token",
  };
}

function runtimeSummary() {
  return {
    enabled: true,
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
    alertCodes: [] as string[],
  };
}

describe("backup catalogue disabled-first composition", () => {
  test("reads only the two gates and never loads the enabled provider graph", async () => {
    const reads: string[] = [];
    const env = new Proxy(
      {
        AGENT_BACKUP_CATALOG_RUNTIME_ENABLED: "0",
        AGENT_BACKUP_RPO_SCHEDULER_ENABLED: "0",
      } as NodeJS.ProcessEnv,
      {
        get(target, property, receiver) {
          if (typeof property === "string") reads.push(property);
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const loadEnabledComposition = mock(async () => {
      throw new Error("enabled composition must stay unloaded");
    });
    const composition = await createAgentBackupCatalogWorkerComposition({
      env,
      loadEnabledComposition,
    });
    expect(composition.enabled).toBe(false);
    expect((await composition.runCycle()).enabled).toBe(false);
    expect(loadEnabledComposition).not.toHaveBeenCalled();
    expect(reads.sort()).toEqual([
      "AGENT_BACKUP_CATALOG_RUNTIME_ENABLED",
      "AGENT_BACKUP_RPO_SCHEDULER_ENABLED",
    ]);
  });

  test("rejects an orphaned schedule gate before importing enabled dependencies", async () => {
    const loadEnabledComposition = mock(async () => {
      throw new Error("unexpected import");
    });
    expect(() =>
      isAgentBackupCatalogWorkerEnabled({
        AGENT_BACKUP_CATALOG_RUNTIME_ENABLED: "0",
        AGENT_BACKUP_RPO_SCHEDULER_ENABLED: "1",
      }),
    ).toThrow(/requires/);
    expect(loadEnabledComposition).not.toHaveBeenCalled();
  });

  test("loads one enabled production module and forwards exactly one cycle", async () => {
    const runCycle = mock(async () => runtimeSummary());
    const createEnabled = mock(async () => ({ enabled: true, runCycle }));
    const composition = await createAgentBackupCatalogWorkerComposition({
      env: {
        AGENT_BACKUP_CATALOG_RUNTIME_ENABLED: "1",
        AGENT_BACKUP_RPO_SCHEDULER_ENABLED: "0",
      },
      loadEnabledComposition: async () => ({
        createAgentBackupCatalogWorkerEnabledComposition: createEnabled,
      }),
    });
    const signal = new AbortController().signal;
    await composition.runCycle(signal);
    expect(createEnabled).toHaveBeenCalledTimes(1);
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(runCycle).toHaveBeenCalledWith(signal);
  });
});

describe("backup catalogue enabled provider graph", () => {
  test("sorts plugin ids by manifest code-unit order instead of locale collation", () => {
    const env = enabledEnv();
    env.AGENT_BACKUP_RUNTIME_PLUGINS_JSON = JSON.stringify([
      { id: "a_b", version: "1.0.0" },
      { id: "a-b", version: "1.0.0" },
    ]);
    expect(readAgentBackupCatalogWorkerEnabledConfig(env).runtimeMetadata.plugins).toEqual([
      { id: "a-b", version: "1.0.0" },
      { id: "a_b", version: "1.0.0" },
    ]);
  });

  test("validates the complete config before constructing a provider", async () => {
    const createRegistry = mock(async () => ({}));
    await expect(
      createAgentBackupCatalogWorkerEnabledComposition({
        env: {
          AGENT_BACKUP_CATALOG_RUNTIME_ENABLED: "1",
          AGENT_BACKUP_RPO_SCHEDULER_ENABLED: "0",
        },
        dependencies: { createRegistry: createRegistry as never },
      }),
    ).rejects.toThrow(/AGENT_BACKUP_CATALOG_WORKER_ID/);
    expect(createRegistry).not.toHaveBeenCalled();
  });

  test("rejects database and field-encryption fallbacks before constructing a provider", async () => {
    const createRegistry = mock(async () => ({}));
    const missingDatabase = enabledEnv();
    delete missingDatabase.DATABASE_URL;
    await expect(
      createAgentBackupCatalogWorkerEnabledComposition({
        env: missingDatabase,
        dependencies: { createRegistry: createRegistry as never },
      }),
    ).rejects.toThrow(/DATABASE_URL/);

    const missingMasterKey = enabledEnv();
    delete missingMasterKey.SECRETS_MASTER_KEY;
    await expect(
      createAgentBackupCatalogWorkerEnabledComposition({
        env: missingMasterKey,
        dependencies: { createRegistry: createRegistry as never },
      }),
    ).rejects.toThrow(/SECRETS_MASTER_KEY/);
    expect(createRegistry).not.toHaveBeenCalled();
  });

  test("rejects provider deadlines that can outlive the operation lease fence", async () => {
    const createRegistry = mock(async () => ({}));
    for (const deadlineName of [
      "AGENT_BACKUP_CAPTURE_DEADLINE_MS",
      "AGENT_BACKUP_OBJECT_TRANSFER_DEADLINE_MS",
    ] as const) {
      const env = enabledEnv();
      env.AGENT_BACKUP_OPERATION_LEASE_MS = "240000";
      env[deadlineName] = "210001";
      await expect(
        createAgentBackupCatalogWorkerEnabledComposition({
          env,
          dependencies: { createRegistry: createRegistry as never },
        }),
      ).rejects.toThrow(/leave 30000ms.*OPERATION_LEASE_MS/);
    }
    expect(createRegistry).not.toHaveBeenCalled();
  });

  test("rejects control characters before constructing provider authorities", async () => {
    const createRegistry = mock(async () => ({}));
    for (const [name, value] of [
      ["AGENT_BACKUP_CATALOG_WORKER_ID", "worker\tshadow"],
      ["AGENT_BACKUP_R2_ENDPOINT_ALIAS", "r2\tshadow"],
      ["AGENT_BACKUP_HETZNER_BUCKET", "bucket\nshadow"],
      ["AGENT_BACKUP_HETZNER_ACCOUNT_ID", "a".repeat(257)],
      ["AGENT_BACKUP_STEWARD_KMS_TOKEN", "kms-token\nshadow"],
    ] as const) {
      const env = enabledEnv();
      env[name] = value;
      await expect(
        createAgentBackupCatalogWorkerEnabledComposition({
          env,
          dependencies: { createRegistry: createRegistry as never },
        }),
      ).rejects.toThrow(name);
    }
    expect(createRegistry).not.toHaveBeenCalled();
  });

  test("binds one registry, KMS, key bundle and spool across the real runtime cycle", async () => {
    const registry = { kind: "registry" };
    const kms = { kind: "kms" };
    const keyBundle = { kind: "key-bundle" };
    const resolveContext = mock(async () => ({}));
    const captureExecutor = { kind: "capture" };
    const resolveSource = mock(async () => ({}));
    const publicationExecutor = { kind: "publication" };
    const janitor = { kind: "janitor" };
    const createRegistry = mock(async () => registry);
    const createKms = mock(() => kms);
    const createKeyBundle = mock(() => keyBundle);
    const createContextResolver = mock(() => resolveContext);
    const createCaptureExecutor = mock(() => captureExecutor);
    const createPublicationSource = mock(() => resolveSource);
    const createPublicationExecutor = mock(() => publicationExecutor);
    const createJanitor = mock(() => janitor);
    const runCycle = mock(async () => runtimeSummary());
    const composition = await createAgentBackupCatalogWorkerEnabledComposition({
      env: enabledEnv(),
      dependencies: {
        createRegistry: createRegistry as never,
        createKms: createKms as never,
        createKeyBundle: createKeyBundle as never,
        createContextResolver: createContextResolver as never,
        createCaptureExecutor: createCaptureExecutor as never,
        createPublicationSource: createPublicationSource as never,
        createPublicationExecutor: createPublicationExecutor as never,
        createJanitor: createJanitor as never,
        runCycle: runCycle as never,
      },
    });
    const signal = new AbortController().signal;
    await composition.runCycle(signal);

    expect(createRegistry).toHaveBeenCalledTimes(1);
    expect(createKms).toHaveBeenCalledTimes(1);
    expect(createKeyBundle).toHaveBeenCalledTimes(1);
    expect(createContextResolver).toHaveBeenCalledTimes(1);
    expect(createCaptureExecutor).toHaveBeenCalledTimes(1);
    expect(createPublicationSource).toHaveBeenCalledTimes(1);
    expect(createPublicationExecutor).toHaveBeenCalledTimes(1);
    expect(createJanitor).toHaveBeenCalledTimes(1);
    expect(createContextResolver.mock.calls[0]?.[0]).toMatchObject({
      keyBundle,
      spool: { stateDirectory: "/var/lib/eliza-backup-catalog/spool" },
    });
    expect(createPublicationSource.mock.calls[0]?.[0]).toMatchObject({
      spool: { stateDirectory: "/var/lib/eliza-backup-catalog/spool" },
    });
    expect(createPublicationExecutor.mock.calls[0]?.[0]).toMatchObject({ registry, resolveSource });
    expect(runCycle.mock.calls[0]?.[0]).toMatchObject({
      registry,
      captureExecutor,
      publicationExecutor,
      spoolCleanupJanitor: janitor,
      signal,
    });
  });
});
