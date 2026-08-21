/**
 * Real enabled composition for the dedicated manifest-v3 catalogue worker.
 * This module is imported only after the disabled-first gate boundary. It
 * validates all configuration before constructing one shared registry, spool,
 * Steward KMS/key-bundle provider, capture/publication pair, and janitor.
 */

import path from "node:path";
import {
  createKmsClient,
  KmsAeadOperationKeyBundleProvider,
  type KmsClient,
} from "@elizaos/core/security/kms";
import { AGENT_BACKUP_CAPTURE_V2_LIMITS } from "@elizaos/shared";
import { recordCapturedAgentBackupManifest } from "../../db/repositories/agent-backup-catalog";
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
  createAgentBackupCatalogRegistryFromEnv,
  readAgentBackupCatalogRuntimeConfig,
  runAgentBackupCatalogRuntimeCycle,
} from "./agent-backup-catalog-runtime";
import type { AgentBackupCatalogWorkerComposition } from "./agent-backup-catalog-worker-composition";
import { createAgentBackupCatalogPublicationExecutor } from "./agent-backup-publication-executor";

const MAX_SPOOL_BYTES = 1024 ** 4;
const MAX_TOKEN_BYTES = 16 * 1024;
const PLUGIN_ID_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/;
const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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

export interface AgentBackupCatalogWorkerEnabledCompositionDependencies {
  createRegistry: typeof createAgentBackupCatalogRegistryFromEnv;
  createKms(options: { baseUrl: string; tokenProvider: () => Promise<string> }): KmsClient;
  createKeyBundle(kms: KmsClient): KmsAeadOperationKeyBundleProvider;
  createContextResolver: typeof createAgentBackupCaptureV3RuntimeContextResolver;
  createCaptureExecutor: typeof createAgentBackupCaptureV2CatalogExecutor;
  createPublicationSource: typeof createAgentBackupCaptureV3PublicationSourceResolver;
  createPublicationExecutor: typeof createAgentBackupCatalogPublicationExecutor;
  createJanitor: typeof createAgentBackupCaptureV3SpoolCleanupJanitor;
  runCycle: typeof runAgentBackupCatalogRuntimeCycle;
}

function requiredText(env: NodeJS.ProcessEnv, name: string, maxBytes = 512): string {
  const value = env[name];
  if (
    !value ||
    value !== value.trim() ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new Error(`${name} must be explicitly configured with a canonical value`);
  }
  return value;
}

function requiredSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES) {
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
  result.sort((left, right) => left.id.localeCompare(right.id));
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

/** Validate the complete enabled contract before any provider or spool is created. */
export function readAgentBackupCatalogWorkerEnabledConfig(
  env: NodeJS.ProcessEnv,
): AgentBackupCatalogWorkerEnabledConfig {
  const runtime = readAgentBackupCatalogRuntimeConfig(env);
  if (!runtime.enabled) throw new Error("Enabled backup catalogue composition requires its gate");

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

  // Validate every storage name up-front; the registry factory is not allowed
  // to partially initialize before a later configuration failure is found.
  for (const name of [
    "AGENT_BACKUP_R2_ENDPOINT_ALIAS",
    "AGENT_BACKUP_R2_ACCOUNT_ID",
    "AGENT_BACKUP_R2_BUCKET",
    "AGENT_BACKUP_R2_REGION",
    "AGENT_BACKUP_R2_ENDPOINT",
    "AGENT_BACKUP_R2_ACCESS_KEY_ID",
    "AGENT_BACKUP_HETZNER_ENDPOINT_ALIAS",
    "AGENT_BACKUP_HETZNER_ACCOUNT_ID",
    "AGENT_BACKUP_HETZNER_ENDPOINT",
    "AGENT_BACKUP_HETZNER_BUCKET",
    "AGENT_BACKUP_HETZNER_REGION",
    "AGENT_BACKUP_HETZNER_ACCESS_KEY_ID",
  ] as const) {
    requiredText(env, name, 2048);
  }
  requiredSecret(env, "AGENT_BACKUP_R2_SECRET_ACCESS_KEY");
  requiredSecret(env, "AGENT_BACKUP_HETZNER_SECRET_ACCESS_KEY");
  canonicalUrl(env, "AGENT_BACKUP_R2_ENDPOINT");
  canonicalUrl(env, "AGENT_BACKUP_HETZNER_ENDPOINT");

  const primaryEndpointAlias = requiredText(env, "AGENT_BACKUP_R2_ENDPOINT_ALIAS");
  const secondaryEndpointAlias = requiredText(env, "AGENT_BACKUP_HETZNER_ENDPOINT_ALIAS");
  if (primaryEndpointAlias === secondaryEndpointAlias) {
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
  return {
    runtime,
    spool: { stateDirectory, maxSpoolBytes, minFreeBytes },
    spoolCleanupBatchSize: boundedInteger({
      env,
      name: "AGENT_BACKUP_SPOOL_CLEANUP_BATCH_SIZE",
      min: 1,
      max: 100,
    }),
    captureDeadlineMs: boundedInteger({
      env,
      name: "AGENT_BACKUP_CAPTURE_DEADLINE_MS",
      min: 1,
      max: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDeadlineAheadMs,
    }),
    publication: {
      scope,
      primaryEndpointAlias,
      secondaryEndpointAlias,
      objectTransferDeadlineMs: boundedInteger({
        env,
        name: "AGENT_BACKUP_OBJECT_TRANSFER_DEADLINE_MS",
        min: 1,
        max: 15 * 60_000,
      }),
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
  runCycle: runAgentBackupCatalogRuntimeCycle,
};

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
  return Object.freeze({
    enabled: true,
    runCycle: (signal?: AbortSignal) =>
      dependencies.runCycle({
        config: config.runtime,
        registry,
        captureExecutor,
        publicationExecutor,
        spoolCleanupJanitor,
        signal,
      }),
  });
}
