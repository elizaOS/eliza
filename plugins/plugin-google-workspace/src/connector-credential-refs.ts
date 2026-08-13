/**
 * Persists OAuth credential material for a connector account and reads the
 * resulting refs back out. `persistConnectorCredentialRefs` writes each secret
 * to the first available durable vault (connector credential store or vault)
 * and records a `vaultRef` pointer on the account via storage. With no durable
 * writer the #18080 product contract applies: durability-expected topologies
 * (Cloud-provisioned containers via `ELIZA_CLOUD_PROVISIONED`, hosts whose
 * credential store registered but failed to start, or operators who set
 * `ELIZA_REQUIRE_DURABLE_CONNECTOR_CREDENTIALS=1`) fail closed with a typed
 * `CONNECTOR_CREDENTIAL_WRITER_UNAVAILABLE` error and record neither secret
 * nor ref, while hostless local desktop/dev runtimes keep the pre-existing
 * volatile SECRETS keep-until-restart write, flagged `volatile` in the result
 * and warned in the log (the credential dies with the process). SECRETS also
 * remains a read-side probe in `credential-resolver.ts` so previously written
 * refs still resolve within the same process.
 * `credentialRefRecordsFromMetadata` is the read side, extracting ref records
 * from account metadata for the credential resolver. Consumed by the connector
 * account provider on OAuth completion and by `DefaultGoogleCredentialResolver`.
 */
import {
  CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE,
  type ConnectorAccountManager,
  ElizaError,
  type IAgentRuntime,
  logger,
  resolveSetting,
} from "@elizaos/core";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { readonly [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;

/**
 * Runtime service names probed, in precedence order, for the durable
 * connector credential store and the vault. The credential resolver's read
 * path (`credential-resolver.ts`) resolves EXACTLY this set in this order:
 * any store a credential can be written to must be findable under the same
 * name after a restart, or the persisted vaultRef dangles and every
 * credential read comes back empty.
 */
export const CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPES = [
  "connector_credential_store",
  "CONNECTOR_CREDENTIAL_STORE",
  "connectorCredentialStore",
  "credential_store",
] as const;

export const CONNECTOR_VAULT_SERVICE_TYPES = ["vault", "VAULT"] as const;

export const CORE_SECRETS_SERVICE_TYPE = "SECRETS";

/**
 * Stable ElizaError code thrown when OAuth completion must fail closed because
 * no durable credential writer can hold the token material (#18080).
 */
export const CONNECTOR_CREDENTIAL_WRITER_UNAVAILABLE_CODE =
  "CONNECTOR_CREDENTIAL_WRITER_UNAVAILABLE";

/**
 * Opt-in strict mode for hostless local runtimes: set to `1`/`true` to fail
 * OAuth completion closed instead of accepting the volatile keep-until-restart
 * SECRETS write. Durability-expected topologies (Cloud-provisioned containers,
 * hosts whose credential store registered) fail closed regardless.
 */
export const REQUIRE_DURABLE_CONNECTOR_CREDENTIALS_SETTING =
  "ELIZA_REQUIRE_DURABLE_CONNECTOR_CREDENTIALS";

export interface ConnectorCredentialRefMetadata extends JsonRecord {
  credentialType: string;
  vaultRef: string;
  expiresAt?: number;
  metadata?: JsonRecord;
}

export interface ConnectorCredentialRefRecordLike {
  credentialType: string;
  vaultRef?: string | null;
  metadata?: JsonRecord | null;
  expiresAt?: number | string | Date | null;
  updatedAt?: number | string | Date | null;
  version?: string | number | null;
}

export interface ConnectorCredentialPersistResult {
  refs: ConnectorCredentialRefMetadata[];
  vaultAvailable: boolean;
  storageAvailable: boolean;
  /**
   * True when the secret landed in the volatile SECRETS store (hostless local
   * desktop/dev keep-until-restart mode): the credential works now but dies
   * with the process, and the ref will dangle after a restart.
   */
  volatile: boolean;
}

interface ConnectorCredentialInput {
  credentialType: string;
  value: string;
  expiresAt?: number;
  metadata?: JsonRecord;
}

interface PersistConnectorCredentialRefsParams {
  runtime: IAgentRuntime;
  manager?: ConnectorAccountManager;
  provider: string;
  accountIdForRef: string;
  storageAccountId?: string;
  credentials: ConnectorCredentialInput[];
  caller: string;
}

type VaultWriter = {
  name: string;
  write: (vaultRef: string, credential: ConnectorCredentialInput) => Promise<string>;
};

type CredentialRefWriter = {
  name: string;
  write: (ref: ConnectorCredentialRefMetadata) => Promise<void>;
};

export async function persistConnectorCredentialRefs(
  params: PersistConnectorCredentialRefsParams
): Promise<ConnectorCredentialPersistResult> {
  const refs: ConnectorCredentialRefMetadata[] = [];
  const writerContext = {
    provider: params.provider,
    accountId: params.accountIdForRef,
    caller: params.caller,
  };
  const vaultWriters = resolveVaultWriters(params.runtime, writerContext);
  let volatileWrite = false;
  if (vaultWriters.length === 0) {
    // Product contract from #18080: durability-expected topologies fail
    // closed; hostless local desktop/dev keeps the pre-existing volatile
    // keep-until-restart behavior unless the operator opts into strict mode.
    const cloudProvisioned = flagIsSet(params.runtime, "ELIZA_CLOUD_PROVISIONED");
    const requireDurable = flagIsSet(params.runtime, REQUIRE_DURABLE_CONNECTOR_CREDENTIALS_SETTING);
    // A durable store/vault service name that is REGISTERED on the runtime but
    // resolved no writer means the store failed to start — a transient boot
    // failure must fail closed, not silently demote persistence.
    const registeredDurableServices = registeredDurableServiceTypes(params.runtime);
    const volatileWriter = resolveVolatileSecretsWriter(params.runtime);
    if (
      cloudProvisioned ||
      requireDurable ||
      registeredDurableServices.length > 0 ||
      !volatileWriter
    ) {
      throw new ElizaError(
        `No durable connector credential store or vault writer is available for ${params.provider} account ${params.accountIdForRef}. ` +
          "Refusing to mark OAuth account connected without persisted credentials: the core SECRETS store is process-memory only, so a credential written there would silently die at the next restart while its vaultRef dangles. " +
          "Run under a host that installs a durable vault (so the connector credential store service registers), or retry after that service has started.",
        {
          code: CONNECTOR_CREDENTIAL_WRITER_UNAVAILABLE_CODE,
          severity: "fatal",
          context: {
            provider: params.provider,
            accountId: params.accountIdForRef,
            caller: params.caller,
            probedStoreServices: [...CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPES],
            probedVaultServices: [...CONNECTOR_VAULT_SERVICE_TYPES],
            registeredDurableServices,
            cloudProvisioned,
            requireDurable,
            volatileFallbackAvailable: Boolean(volatileWriter),
          },
        }
      );
    }
    logger.warn(
      {
        src: "plugin:google:credential-refs",
        provider: params.provider,
        accountId: params.accountIdForRef,
      },
      "[persistConnectorCredentialRefs] No durable credential writer; persisting through the volatile SECRETS store (hostless local mode). The credential works until the process restarts. Install a durable host vault, or set ELIZA_REQUIRE_DURABLE_CONNECTOR_CREDENTIALS=1 to fail closed instead."
    );
    vaultWriters.push(volatileWriter);
    volatileWrite = true;
  }
  if (!params.storageAccountId) {
    throw new Error(
      `No durable connector account id is available for ${params.provider} account ${params.accountIdForRef}. Refusing to mark OAuth account connected without persisted credential refs.`
    );
  }
  const storageWriters = resolveCredentialRefWriters(
    params.runtime,
    params.manager,
    params.storageAccountId
  );
  if (storageWriters.length === 0) {
    throw new Error(
      `No durable connector credential ref writer is available for ${params.provider} account ${params.storageAccountId}. Refusing to mark OAuth account connected without persisted credential refs.`
    );
  }

  for (const credential of params.credentials) {
    const plannedRef = buildConnectorCredentialVaultRef({
      agentId: nonEmptyString(params.runtime.agentId) ?? "agent",
      provider: params.provider,
      accountId: params.accountIdForRef,
      credentialType: credential.credentialType,
    });
    const vaultRef = await writeWithFirstAvailableVault(vaultWriters, plannedRef, credential);
    refs.push({
      credentialType: credential.credentialType,
      vaultRef,
      ...(credential.expiresAt !== undefined ? { expiresAt: credential.expiresAt } : {}),
      ...(credential.metadata ? { metadata: credential.metadata } : {}),
    });
  }

  if (refs.length > 0) {
    await writeRefsToStorage(storageWriters, refs);
  }

  return {
    refs,
    vaultAvailable: vaultWriters.length > 0 && !volatileWrite,
    storageAvailable: storageWriters.length > 0,
    volatile: volatileWrite,
  };
}

export function credentialRefRecordsFromMetadata(
  metadata: unknown
): ConnectorCredentialRefRecordLike[] {
  const record = asRecord(metadata);
  if (!record) return [];

  const oauth = asRecord(record.oauth);
  return [
    ...credentialRefsFromUnknown(record.credentialRefs),
    ...credentialRefsFromUnknown(record.oauthCredentialRefs),
    ...credentialRefsFromUnknown(oauth?.credentialRefs),
  ];
}

function credentialRefsFromUnknown(value: unknown): ConnectorCredentialRefRecordLike[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const ref = credentialRefFromRecord(asRecord(entry));
      return ref ? [ref] : [];
    });
  }

  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([credentialType, entry]) => {
    const entryRecord = asRecord(entry);
    if (entryRecord) {
      const ref = credentialRefFromRecord({
        credentialType,
        ...entryRecord,
      });
      return ref ? [ref] : [];
    }
    const vaultRef = nonEmptyString(entry);
    return vaultRef ? [{ credentialType, vaultRef }] : [];
  });
}

function credentialRefFromRecord(
  record: JsonRecord | undefined
): ConnectorCredentialRefRecordLike | null {
  if (!record) return null;
  const credentialType = nonEmptyString(record.credentialType ?? record.type ?? record.name);
  const vaultRef = nonEmptyString(record.vaultRef ?? record.ref);
  if (!credentialType || !vaultRef) return null;
  return {
    credentialType,
    vaultRef,
    metadata: asRecord(record.metadata) ?? null,
    expiresAt: record.expiresAt as ConnectorCredentialRefRecordLike["expiresAt"],
    updatedAt: record.updatedAt as ConnectorCredentialRefRecordLike["updatedAt"],
    version: (record.version ??
      record.credentialVersion) as ConnectorCredentialRefRecordLike["version"],
  };
}

function resolveVaultWriters(
  runtime: IAgentRuntime,
  context: { provider: string; accountId: string; caller: string }
): VaultWriter[] {
  const writers: VaultWriter[] = [];
  const credentialStore = getFirstService(runtime, CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPES) as {
    putSecret?: (params: {
      vaultRef?: string;
      agentId: string;
      provider: string;
      accountId: string;
      credentialType: string;
      value: string;
      caller?: string;
    }) => Promise<string> | string;
  } | null;
  if (typeof credentialStore?.putSecret === "function") {
    writers.push({
      name: "connector_credential_store",
      write: async (vaultRef, credential) =>
        credentialStore.putSecret?.({
          vaultRef,
          agentId: nonEmptyString(runtime.agentId) ?? "agent",
          provider: context.provider,
          accountId: context.accountId,
          credentialType: credential.credentialType,
          value: credential.value,
          caller: context.caller,
        }) ?? vaultRef,
    });
  }

  const vault = getFirstService(runtime, CONNECTOR_VAULT_SERVICE_TYPES) as {
    set?: (
      key: string,
      value: string,
      options?: { sensitive?: boolean; caller?: string }
    ) => Promise<void> | void;
  } | null;
  if (typeof vault?.set === "function") {
    writers.push({
      name: "vault",
      write: async (vaultRef, credential) => {
        await vault.set?.(vaultRef, credential.value, {
          sensitive: true,
          caller: context.caller,
        });
        return vaultRef;
      },
    });
  }

  // Deliberately no SECRETS writer here: core SECRETS global storage is
  // process-memory only, so accepting it as a durable writer records a
  // connected account whose credential dies at the next restart (#18080).
  // `persistConnectorCredentialRefs` decides whether the volatile fallback
  // below is allowed to stand in when this list comes back empty.
  return writers;
}

/**
 * Volatile keep-until-restart writer over the core SECRETS store — the
 * pre-#18080 behavior, now allowed ONLY on hostless local desktop/dev
 * runtimes where no durability was ever expected.
 */
function resolveVolatileSecretsWriter(runtime: IAgentRuntime): VaultWriter | null {
  const secrets = getService(runtime, CORE_SECRETS_SERVICE_TYPE) as {
    setGlobal?: (
      key: string,
      value: string,
      config?: { sensitive?: boolean }
    ) => Promise<boolean> | boolean;
    set?: (
      key: string,
      value: string,
      context: JsonRecord,
      config?: { sensitive?: boolean }
    ) => Promise<boolean> | boolean;
  } | null;
  if (typeof secrets?.setGlobal !== "function" && typeof secrets?.set !== "function") {
    return null;
  }
  return {
    name: "SECRETS",
    write: async (vaultRef, credential) => {
      if (typeof secrets.setGlobal === "function") {
        await secrets.setGlobal(vaultRef, credential.value, { sensitive: true });
        return vaultRef;
      }
      await secrets.set?.(
        vaultRef,
        credential.value,
        { level: "global", agentId: runtime.agentId, requesterId: runtime.agentId },
        { sensitive: true }
      );
      return vaultRef;
    },
  };
}

/**
 * Durable store/vault service names registered on this runtime, regardless of
 * whether they resolved to a usable writer. A non-empty result with zero
 * writers means the durable store failed to start.
 */
function registeredDurableServiceTypes(runtime: IAgentRuntime): string[] {
  const registered = (
    runtime as { getRegisteredServiceTypes?: () => string[] }
  ).getRegisteredServiceTypes?.();
  if (!Array.isArray(registered)) return [];
  const durableNames = new Set<string>([
    ...CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPES,
    ...CONNECTOR_VAULT_SERVICE_TYPES,
  ]);
  return registered.filter((name) => durableNames.has(name));
}

function flagIsSet(runtime: IAgentRuntime, key: string): boolean {
  const value = resolveSetting(runtime, key)?.toLowerCase();
  return value === "1" || value === "true";
}

function resolveCredentialRefWriters(
  runtime: IAgentRuntime,
  manager: ConnectorAccountManager | undefined,
  accountId: string
): CredentialRefWriter[] {
  const candidates = [
    manager?.getStorage?.(),
    getService(runtime, CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE),
    (runtime as { adapter?: unknown }).adapter,
  ].filter(Boolean);

  const writers: CredentialRefWriter[] = [];
  for (const candidate of candidates) {
    const writer = candidate as {
      setConnectorAccountCredentialRef?: (params: {
        accountId: string;
        credentialType: string;
        vaultRef: string;
        metadata?: JsonRecord;
        expiresAt?: number;
      }) => Promise<unknown> | unknown;
      setCredentialRef?: (params: {
        accountId: string;
        credentialType: string;
        vaultRef: string;
        metadata?: JsonRecord;
        expiresAt?: number;
      }) => Promise<unknown> | unknown;
    };
    if (typeof writer.setConnectorAccountCredentialRef === "function") {
      writers.push({
        name: "setConnectorAccountCredentialRef",
        write: async (ref) => {
          await writer.setConnectorAccountCredentialRef?.({
            accountId,
            credentialType: ref.credentialType,
            vaultRef: ref.vaultRef,
            ...(ref.metadata ? { metadata: ref.metadata } : {}),
            ...(ref.expiresAt !== undefined ? { expiresAt: ref.expiresAt } : {}),
          });
        },
      });
    } else if (typeof writer.setCredentialRef === "function") {
      writers.push({
        name: "setCredentialRef",
        write: async (ref) => {
          await writer.setCredentialRef?.({
            accountId,
            credentialType: ref.credentialType,
            vaultRef: ref.vaultRef,
            ...(ref.metadata ? { metadata: ref.metadata } : {}),
            ...(ref.expiresAt !== undefined ? { expiresAt: ref.expiresAt } : {}),
          });
        },
      });
    }
  }
  return writers;
}

async function writeWithFirstAvailableVault(
  writers: VaultWriter[],
  plannedRef: string,
  credential: ConnectorCredentialInput
): Promise<string> {
  const errors: string[] = [];
  for (const writer of writers) {
    try {
      return await writer.write(plannedRef, credential);
    } catch (error) {
      errors.push(`${writer.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Failed to persist connector credential ref ${plannedRef}: ${errors.join("; ")}`);
}

async function writeRefsToStorage(
  writers: CredentialRefWriter[],
  refs: ConnectorCredentialRefMetadata[]
): Promise<void> {
  const errors: string[] = [];
  for (const writer of writers) {
    try {
      for (const ref of refs) {
        await writer.write(ref);
      }
      return;
    } catch (error) {
      errors.push(`${writer.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Failed to persist connector credential refs: ${errors.join("; ")}`);
}

function buildConnectorCredentialVaultRef(params: {
  agentId: string;
  provider: string;
  accountId: string;
  credentialType: string;
}): string {
  return [
    "connector",
    normalizeVaultSegment(params.agentId),
    normalizeVaultSegment(params.provider),
    normalizeVaultSegment(params.accountId),
    normalizeVaultSegment(params.credentialType),
  ].join(".");
}

function normalizeVaultSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (normalized || "unknown").slice(0, 64);
}

function getFirstService(runtime: IAgentRuntime, serviceTypes: readonly string[]): unknown {
  for (const serviceType of serviceTypes) {
    const service = getService(runtime, serviceType);
    if (service) return service;
  }
  return null;
}

function getService(runtime: IAgentRuntime, serviceType: string): unknown {
  try {
    return runtime.getService?.(serviceType) ?? null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
