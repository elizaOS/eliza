/**
 * Real enabled composition for the dedicated manifest-v3 catalogue worker.
 * This module is imported only after the disabled-first gate boundary. It
 * validates all configuration before constructing one shared registry, spool,
 * Steward KMS/key-bundle provider, capture/publication pair, and janitor.
 */

import path from "node:path";
import { ElizaError } from "@elizaos/core/edge";
import {
  createKmsClient,
  KmsAeadOperationKeyBundleProvider,
  type KmsClient,
} from "@elizaos/core/security/kms";
import { AGENT_BACKUP_CAPTURE_V2_LIMITS } from "@elizaos/shared";
import { recordCapturedAgentBackupManifest } from "../../db/repositories/agent-backup-catalog";
import type { RuntimeR2Bucket } from "../storage/r2-runtime-binding";
import { createAccountDeletionBackupAuthority } from "./account-deletion-backup-authority";
import { createAccountDeletionProviderAdapters } from "./account-deletion-provider-adapters";
import { processIrreversibleAccountDeletionSaga } from "./account-deletion-saga";
import { createAccountDeletionSpoolAuthority } from "./account-deletion-spool-authority";
import {
  type AgentBackupCaptureV3LegacyWriterDrainReceipt,
  createAgentBackupCaptureV2CatalogExecutor,
} from "./agent-backup-capture-v2-catalog-executor";
import type { AgentBackupCaptureV3SpoolConfig } from "./agent-backup-capture-v2-spool";
import { createAgentBackupCaptureV3PublicationSourceResolver } from "./agent-backup-capture-v3-publication-source";
import { createAgentBackupCaptureV3RuntimeContextResolver } from "./agent-backup-capture-v3-runtime-context";
import { createAgentBackupCaptureV3SpoolCleanupJanitor } from "./agent-backup-capture-v3-spool-cleanup";
import {
  type AgentBackupCatalogRuntimeConfig,
  type AgentBackupCatalogRuntimeSummary,
  createAgentBackupCatalogRegistryFromEnv,
  readAgentBackupCatalogRuntimeConfig,
  runAgentBackupCatalogRuntimeCycle,
} from "./agent-backup-catalog-runtime";
import type { AgentBackupCatalogWorkerComposition } from "./agent-backup-catalog-worker-composition";
import { createAgentBackupCatalogPublicationExecutor } from "./agent-backup-publication-executor";

const MAX_SPOOL_BYTES = 1024 ** 4;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_PROVIDER_IDENTITY_BYTES = 256;
const PLUGIN_ID_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/;
const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION_LEASE_SETTLEMENT_MARGIN_MS = 30_000;

function applicationObjectAuthorityUnavailable(operation: string): ElizaError {
  return new ElizaError(
    `Backup authority worker cannot ${operation} the application object bucket`,
    {
      code: "ACCOUNT_DELETION_APPLICATION_OBJECT_AUTHORITY_UNAVAILABLE",
      context: { operation },
      severity: "fatal",
    },
  );
}

export interface AgentBackupCatalogWorkerEnabledConfig {
  runtime: Extract<AgentBackupCatalogRuntimeConfig, { enabled: true }>;
  spool: AgentBackupCaptureV3SpoolConfig;
  spoolCleanupBatchSize: number;
  captureDeadlineMs: number;
  publication: {
    scope: string;
    primaryEndpointAlias: string;
    secondaryEndpointAlias: string;
    objectTransferDeadlineMs: number;
  };
  runtimeMetadata: {
    agentSchemaVersion: string;
    databaseSchemaVersion: string;
    plugins: readonly { id: string; version: string }[];
  };
  legacyWriterDrain: AgentBackupCaptureV3LegacyWriterDrainReceipt;
  kms: {
    baseUrl: string;
    token: string;
  };
}

export interface AccountDeletionBackupAuthorityConfig {
  spool: AgentBackupCaptureV3SpoolConfig;
}

export interface AgentBackupCatalogWorkerEnabledCompositionDependencies {
  createRegistry: typeof createAgentBackupCatalogRegistryFromEnv;
  createKms(options: { baseUrl: string; tokenProvider: () => Promise<string> }): KmsClient;
  createKeyBundle(kms: KmsClient): KmsAeadOperationKeyBundleProvider;
  createContextResolver: typeof createAgentBackupCaptureV3RuntimeContextResolver;
  createCaptureExecutor: typeof createAgentBackupCaptureV2CatalogExecutor;
  createPublicationSource: typeof createAgentBackupCaptureV3PublicationSourceResolver;
  createPublicationExecutor: typeof createAgentBackupCatalogPublicationExecutor;
  createJanitor: typeof createAgentBackupCaptureV3SpoolCleanupJanitor;
  createAccountDeletionBackup: typeof createAccountDeletionBackupAuthority;
  createAccountDeletionSpool: typeof createAccountDeletionSpoolAuthority;
  processAccountDeletionAuthorities: typeof processAccountDeletionAuthorities;
  runCycle: typeof runAgentBackupCatalogRuntimeCycle;
}

const AUTHORITY_ONLY_BLOB: RuntimeR2Bucket = Object.freeze({
  async get() {
    throw applicationObjectAuthorityUnavailable("read");
  },
  async put() {
    throw applicationObjectAuthorityUnavailable("write");
  },
  async delete() {
    throw applicationObjectAuthorityUnavailable("delete from");
  },
});

async function processAccountDeletionAuthorities(input: {
  backup: ReturnType<typeof createAccountDeletionBackupAuthority>;
  spool: ReturnType<typeof createAccountDeletionSpoolAuthority>;
}): Promise<void> {
  const adapters = createAccountDeletionProviderAdapters({
    backupAuthority: input.backup,
    spoolAuthority: input.spool,
  });
  await processIrreversibleAccountDeletionSaga({
    limit: 10,
    blob: AUTHORITY_ONLY_BLOB,
    adapters,
    allowedPhases: new Set(["secondary_backups", "spools"]),
  });
}

function requiredText(env: NodeJS.ProcessEnv, name: string, maxBytes = 512): string {
  const value = env[name];
  if (
    !value ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new Error(`${name} must be explicitly configured with a canonical value`);
  }
  return value;
}

function requiredSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (
    !value ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES
  ) {
    throw new Error(`${name} must be explicitly configured when backup catalogue is enabled`);
  }
  return value;
}

function boundedInteger(params: {
  env: NodeJS.ProcessEnv;
  name: string;
  min: number;
  max: number;
}): number {
  const value = requiredText(params.env, params.name, 32);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${params.name} must be a canonical positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < params.min || parsed > params.max) {
    throw new Error(`${params.name} must be between ${params.min} and ${params.max}`);
  }
  return parsed;
}

function canonicalUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = requiredText(env, name, 2048);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new Error(`${name} must be an absolute URL`, { cause });
  }
  const loopbackHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]");
  if (
    (parsed.protocol !== "https:" && !loopbackHttp) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be a credential-free HTTPS URL`);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

function pluginVersions(env: NodeJS.ProcessEnv): readonly { id: string; version: string }[] {
  const raw = requiredText(env, "AGENT_BACKUP_RUNTIME_PLUGINS_JSON", 64 * 1024);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error("AGENT_BACKUP_RUNTIME_PLUGINS_JSON must be valid JSON", { cause });
  }
  if (!Array.isArray(parsed) || parsed.length > 256) {
    throw new Error("AGENT_BACKUP_RUNTIME_PLUGINS_JSON must be an array with at most 256 entries");
  }
  const result = parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`AGENT_BACKUP_RUNTIME_PLUGINS_JSON[${index}] must be an object`);
    }
    const keys = Object.keys(entry).sort();
    const id = Reflect.get(entry, "id");
    const version = Reflect.get(entry, "version");
    if (
      keys.length !== 2 ||
      keys[0] !== "id" ||
      keys[1] !== "version" ||
      typeof id !== "string" ||
      typeof version !== "string" ||
      id.length > 214 ||
      !PLUGIN_ID_PATTERN.test(id) ||
      !VERSION_PATTERN.test(version)
    ) {
      throw new Error(`AGENT_BACKUP_RUNTIME_PLUGINS_JSON[${index}] is not canonical`);
    }
    return { id, version };
  });
  // Manifest canonicalization compares code units, not locale collation.
  result.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (result.some((entry, index) => index > 0 && entry.id === result[index - 1]?.id)) {
    throw new Error("AGENT_BACKUP_RUNTIME_PLUGINS_JSON contains a duplicate plugin id");
  }
  return Object.freeze(result.map((entry) => Object.freeze(entry)));
}

function kmsConfig(env: NodeJS.ProcessEnv): AgentBackupCatalogWorkerEnabledConfig["kms"] {
  const baseUrl = canonicalUrl(env, "AGENT_BACKUP_STEWARD_KMS_BASE_URL");
  return {
    baseUrl,
    token: requiredSecret(env, "AGENT_BACKUP_STEWARD_KMS_TOKEN"),
  };
}

/** Validate the always-on deletion authority without enabling capture or scheduling. */
export function readAccountDeletionBackupAuthorityConfig(
  env: NodeJS.ProcessEnv,
): AccountDeletionBackupAuthorityConfig {
  if (env.ACCOUNT_DELETION_BACKUP_AUTHORITY_ENABLED !== "1") {
    throw new Error("Account deletion backup authority composition requires its gate");
  }
  const databaseUrl = requiredText(env, "DATABASE_URL", 16 * 1024);
  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch (cause) {
    throw new Error("DATABASE_URL must be an absolute PostgreSQL URL", { cause });
  }
  if (
    (parsedDatabaseUrl.protocol !== "postgres:" && parsedDatabaseUrl.protocol !== "postgresql:") ||
    !parsedDatabaseUrl.hostname
  ) {
    throw new Error("DATABASE_URL must be an absolute PostgreSQL URL");
  }
  const secretsMasterKey = requiredSecret(env, "SECRETS_MASTER_KEY");
  if (!/^[0-9a-fA-F]{64}$/.test(secretsMasterKey)) {
    throw new Error("SECRETS_MASTER_KEY must be exactly 32 bytes encoded as hexadecimal");
  }
  for (const name of [
    "AGENT_BACKUP_R2_ENDPOINT_ALIAS",
    "AGENT_BACKUP_R2_ACCOUNT_ID",
    "AGENT_BACKUP_R2_BUCKET",
    "AGENT_BACKUP_R2_REGION",
    "AGENT_BACKUP_R2_ACCESS_KEY_ID",
    "AGENT_BACKUP_HETZNER_ENDPOINT_ALIAS",
    "AGENT_BACKUP_HETZNER_ACCOUNT_ID",
    "AGENT_BACKUP_HETZNER_BUCKET",
    "AGENT_BACKUP_HETZNER_REGION",
    "AGENT_BACKUP_HETZNER_ACCESS_KEY_ID",
  ] as const) {
    requiredText(env, name, MAX_PROVIDER_IDENTITY_BYTES);
  }
  for (const name of ["AGENT_BACKUP_R2_ENDPOINT", "AGENT_BACKUP_HETZNER_ENDPOINT"] as const) {
    canonicalUrl(env, name);
  }
  requiredSecret(env, "AGENT_BACKUP_R2_SECRET_ACCESS_KEY");
  requiredSecret(env, "AGENT_BACKUP_HETZNER_SECRET_ACCESS_KEY");
  if (env.AGENT_BACKUP_R2_ENDPOINT_ALIAS === env.AGENT_BACKUP_HETZNER_ENDPOINT_ALIAS) {
    throw new Error("Primary and secondary backup endpoint aliases must be distinct");
  }
  const stateDirectory = requiredText(env, "AGENT_BACKUP_SPOOL_STATE_DIRECTORY", 4096);
  if (!path.isAbsolute(stateDirectory) || path.parse(stateDirectory).root === stateDirectory) {
    throw new Error("AGENT_BACKUP_SPOOL_STATE_DIRECTORY must be a specific absolute path");
  }
  const maxSpoolBytes = boundedInteger({
    env,
    name: "AGENT_BACKUP_SPOOL_MAX_BYTES",
    min: 1024 ** 2,
    max: MAX_SPOOL_BYTES,
  });
  const minFreeBytes = boundedInteger({
    env,
    name: "AGENT_BACKUP_SPOOL_MIN_FREE_BYTES",
    min: 1,
    max: MAX_SPOOL_BYTES,
  });
  if (minFreeBytes >= maxSpoolBytes) {
    throw new Error("AGENT_BACKUP_SPOOL_MIN_FREE_BYTES must be smaller than spool capacity");
  }
  return { spool: { stateDirectory, maxSpoolBytes, minFreeBytes } };
}

/** Validate the complete enabled contract before any provider or spool is created. */
export function readAgentBackupCatalogWorkerEnabledConfig(
  env: NodeJS.ProcessEnv,
): AgentBackupCatalogWorkerEnabledConfig {
  const runtime = readAgentBackupCatalogRuntimeConfig(env);
  if (!runtime.enabled) throw new Error("Enabled backup catalogue composition requires its gate");
  const deletionAuthority = readAccountDeletionBackupAuthorityConfig({
    ...env,
    ACCOUNT_DELETION_BACKUP_AUTHORITY_ENABLED: "1",
  });

  const primaryEndpointAlias = requiredText(
    env,
    "AGENT_BACKUP_R2_ENDPOINT_ALIAS",
    MAX_PROVIDER_IDENTITY_BYTES,
  );
  const secondaryEndpointAlias = requiredText(
    env,
    "AGENT_BACKUP_HETZNER_ENDPOINT_ALIAS",
    MAX_PROVIDER_IDENTITY_BYTES,
  );
  const agentSchemaVersion = requiredText(env, "AGENT_BACKUP_AGENT_SCHEMA_VERSION", 128);
  const databaseSchemaVersion = requiredText(env, "AGENT_BACKUP_DATABASE_SCHEMA_VERSION", 128);
  if (!VERSION_PATTERN.test(agentSchemaVersion) || !VERSION_PATTERN.test(databaseSchemaVersion)) {
    throw new Error("Backup runtime schema versions must be canonical manifest versions");
  }
  const deploymentId = requiredText(env, "AGENT_BACKUP_LEGACY_WRITER_DRAIN_DEPLOYMENT_ID", 128);
  const drainedAt = requiredText(env, "AGENT_BACKUP_LEGACY_WRITER_DRAINED_AT", 64);
  if (
    !DEPLOYMENT_ID_PATTERN.test(deploymentId) ||
    !Number.isFinite(Date.parse(drainedAt)) ||
    new Date(drainedAt).toISOString() !== drainedAt
  ) {
    throw new Error("Backup legacy-writer drain receipt must be canonical");
  }
  const scope = requiredText(env, "AGENT_BACKUP_STORAGE_SCOPE", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope)) {
    throw new Error("AGENT_BACKUP_STORAGE_SCOPE must be a canonical storage scope");
  }
  const captureDeadlineMs = boundedInteger({
    env,
    name: "AGENT_BACKUP_CAPTURE_DEADLINE_MS",
    min: 1,
    max: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDeadlineAheadMs,
  });
  const objectTransferDeadlineMs = boundedInteger({
    env,
    name: "AGENT_BACKUP_OBJECT_TRANSFER_DEADLINE_MS",
    min: 1,
    max: 15 * 60_000,
  });
  const providerDeadlineCeiling = runtime.operationLeaseMs - OPERATION_LEASE_SETTLEMENT_MARGIN_MS;
  if (
    providerDeadlineCeiling < 1 ||
    captureDeadlineMs > providerDeadlineCeiling ||
    objectTransferDeadlineMs > providerDeadlineCeiling
  ) {
    throw new Error(
      "Backup capture and object-transfer deadlines must leave 30000ms inside AGENT_BACKUP_OPERATION_LEASE_MS for fenced settlement",
    );
  }
  return {
    runtime,
    spool: deletionAuthority.spool,
    spoolCleanupBatchSize: boundedInteger({
      env,
      name: "AGENT_BACKUP_SPOOL_CLEANUP_BATCH_SIZE",
      min: 1,
      max: 100,
    }),
    captureDeadlineMs,
    publication: {
      scope,
      primaryEndpointAlias,
      secondaryEndpointAlias,
      objectTransferDeadlineMs,
    },
    runtimeMetadata: {
      agentSchemaVersion,
      databaseSchemaVersion,
      plugins: pluginVersions(env),
    },
    legacyWriterDrain: {
      format: "elizaos.agent-backup.capture-v3-legacy-writer-drain.v1",
      deploymentId,
      drainedAt,
    },
    kms: kmsConfig(env),
  };
}

const DEFAULT_DEPENDENCIES: AgentBackupCatalogWorkerEnabledCompositionDependencies = {
  createRegistry: createAgentBackupCatalogRegistryFromEnv,
  createKms: ({ baseUrl, tokenProvider }) =>
    createKmsClient({ backend: "steward", steward: { baseUrl, tokenProvider } }),
  createKeyBundle: (kms) => new KmsAeadOperationKeyBundleProvider(kms),
  createContextResolver: createAgentBackupCaptureV3RuntimeContextResolver,
  createCaptureExecutor: createAgentBackupCaptureV2CatalogExecutor,
  createPublicationSource: createAgentBackupCaptureV3PublicationSourceResolver,
  createPublicationExecutor: createAgentBackupCatalogPublicationExecutor,
  createJanitor: createAgentBackupCaptureV3SpoolCleanupJanitor,
  createAccountDeletionBackup: createAccountDeletionBackupAuthority,
  createAccountDeletionSpool: createAccountDeletionSpoolAuthority,
  processAccountDeletionAuthorities,
  runCycle: runAgentBackupCatalogRuntimeCycle,
};

type AccountDeletionBackupAuthorityCompositionDependencies = Pick<
  AgentBackupCatalogWorkerEnabledCompositionDependencies,
  | "createRegistry"
  | "createAccountDeletionBackup"
  | "createAccountDeletionSpool"
  | "processAccountDeletionAuthorities"
>;

function accountDeletionAuthoritySummary(): AgentBackupCatalogRuntimeSummary {
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
    alertCodes: [],
  };
}

/**
 * Construct only the always-on account-deletion authorities. Capture,
 * publication, scheduling, KMS, and catalogue GC remain disabled.
 */
export async function createAccountDeletionBackupAuthorityComposition(input: {
  env: NodeJS.ProcessEnv;
  dependencies?: Partial<AccountDeletionBackupAuthorityCompositionDependencies>;
}): Promise<AgentBackupCatalogWorkerComposition> {
  const config = readAccountDeletionBackupAuthorityConfig(input.env);
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies };
  const registry = await dependencies.createRegistry({ env: input.env });
  const accountDeletionAuthorities = Object.freeze({
    backup: dependencies.createAccountDeletionBackup(registry),
    spool: dependencies.createAccountDeletionSpool(config.spool),
  });
  return Object.freeze({
    enabled: true,
    accountDeletionAuthorities,
    async runCycle() {
      await dependencies.processAccountDeletionAuthorities(accountDeletionAuthorities);
      return accountDeletionAuthoritySummary();
    },
  });
}

/** Construct exactly one compatible provider/executor graph for this process. */
export async function createAgentBackupCatalogWorkerEnabledComposition(input: {
  env: NodeJS.ProcessEnv;
  dependencies?: Partial<AgentBackupCatalogWorkerEnabledCompositionDependencies>;
}): Promise<AgentBackupCatalogWorkerComposition> {
  const config = readAgentBackupCatalogWorkerEnabledConfig(input.env);
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies };
  const registry = await dependencies.createRegistry({ env: input.env });
  const kms = dependencies.createKms({
    baseUrl: config.kms.baseUrl,
    tokenProvider: async () => config.kms.token,
  });
  const keyBundle = dependencies.createKeyBundle(kms);
  const resolveContext = dependencies.createContextResolver({
    spool: config.spool,
    keyBundle,
    runtime: config.runtimeMetadata,
  });
  const captureExecutor = dependencies.createCaptureExecutor(
    {
      resolveContext,
      recordCaptured: recordCapturedAgentBackupManifest,
      captureDeadlineMs: config.captureDeadlineMs,
    },
    config.legacyWriterDrain,
  );
  const resolveSource = dependencies.createPublicationSource({ spool: config.spool });
  const publicationExecutor = dependencies.createPublicationExecutor({
    config: config.publication,
    registry,
    resolveSource,
  });
  const spoolCleanupJanitor = dependencies.createJanitor({
    spool: config.spool,
    batchSize: config.spoolCleanupBatchSize,
  });
  const accountDeletionAuthorities = Object.freeze({
    backup: dependencies.createAccountDeletionBackup(registry),
    spool: dependencies.createAccountDeletionSpool(config.spool),
  });
  return Object.freeze({
    enabled: true,
    accountDeletionAuthorities,
    async runCycle(signal?: AbortSignal) {
      const summary = await dependencies.runCycle({
        config: config.runtime,
        registry,
        captureExecutor,
        publicationExecutor,
        spoolCleanupJanitor,
        signal,
      });
      await dependencies.processAccountDeletionAuthorities(accountDeletionAuthorities);
      return summary;
    },
  });
}
