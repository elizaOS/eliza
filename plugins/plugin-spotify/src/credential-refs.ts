/**
 * Persists Spotify OAuth token material into a durable vault and records the
 * resulting refs on the connector account, mirroring the connector credential
 * contract established by plugin-google-workspace: tokens are written to the
 * first available durable store (connector credential store, then vault), a
 * `vaultRef` pointer lands on the account row, and the flow refuses to mark an
 * account connected when no durable writer exists. The in-memory SECRETS
 * service is deliberately not a writer — its contents die with the process.
 * `credentialRefRecordsFromMetadata` is the read side used by the resolver.
 */
import {
  CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE,
  type ConnectorAccountManager,
  type IAgentRuntime,
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

const CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPES = [
  "connector_credential_store",
  "CONNECTOR_CREDENTIAL_STORE",
  "connectorCredentialStore",
  "credential_store",
] as const;

const CONNECTOR_VAULT_SERVICE_TYPES = ["vault", "VAULT"] as const;

export interface SpotifyCredentialRefMetadata extends JsonRecord {
  credentialType: string;
  vaultRef: string;
  expiresAt?: number;
  metadata?: JsonRecord;
}

export interface SpotifyCredentialRefRecordLike {
  credentialType: string;
  vaultRef?: string | null;
  metadata?: JsonRecord | null;
  expiresAt?: number | string | Date | null;
}

interface CredentialInput {
  credentialType: string;
  value: string;
  expiresAt?: number;
  metadata?: JsonRecord;
}

interface PersistParams {
  runtime: IAgentRuntime;
  manager?: ConnectorAccountManager;
  provider: string;
  accountId: string;
  credentials: CredentialInput[];
  caller: string;
}

type VaultWriter = {
  name: string;
  write: (vaultRef: string, credential: CredentialInput) => Promise<string>;
};

type CredentialRefWriter = {
  name: string;
  write: (ref: SpotifyCredentialRefMetadata) => Promise<void>;
};

export interface SpotifyCredentialPersistResult {
  refs: SpotifyCredentialRefMetadata[];
}

export async function persistSpotifyCredentialRefs(
  params: PersistParams
): Promise<SpotifyCredentialPersistResult> {
  const vaultWriters = resolveVaultWriters(params.runtime, params);
  if (vaultWriters.length === 0) {
    throw new Error(
      `No durable connector credential store or vault writer is available for ${params.provider} account ${params.accountId}. Refusing to mark OAuth account connected without persisted credentials.`
    );
  }
  const refWriters = resolveCredentialRefWriters(params.runtime, params.manager, params.accountId);
  if (refWriters.length === 0) {
    throw new Error(
      `No durable connector credential ref writer is available for ${params.provider} account ${params.accountId}. Refusing to mark OAuth account connected without persisted credential refs.`
    );
  }

  const refs: SpotifyCredentialRefMetadata[] = [];
  for (const credential of params.credentials) {
    const plannedRef = buildVaultRef({
      agentId: nonEmptyString(params.runtime.agentId) ?? "agent",
      provider: params.provider,
      accountId: params.accountId,
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
  await writeRefsToStorage(refWriters, refs);
  return { refs };
}

export function credentialRefRecordsFromMetadata(
  metadata: unknown
): SpotifyCredentialRefRecordLike[] {
  const record = asRecord(metadata);
  if (!record) return [];
  const oauth = asRecord(record.oauth);
  return [
    ...credentialRefsFromUnknown(record.credentialRefs),
    ...credentialRefsFromUnknown(record.oauthCredentialRefs),
    ...credentialRefsFromUnknown(oauth?.credentialRefs),
  ];
}

/** Reads a credential value back from the durable stores by its vault ref. */
export async function readCredentialValue(
  runtime: IAgentRuntime,
  vaultRef: string
): Promise<string | undefined> {
  const credentialStore = getFirstService(runtime, CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPES) as {
    getSecret?: (params: { vaultRef: string }) => Promise<string | null> | string | null;
  } | null;
  if (typeof credentialStore?.getSecret === "function") {
    const value = await credentialStore.getSecret({ vaultRef });
    if (nonEmptyString(value)) return value as string;
  }
  const vault = getFirstService(runtime, CONNECTOR_VAULT_SERVICE_TYPES) as {
    get?: (key: string) => Promise<string | null | undefined> | string | null | undefined;
  } | null;
  if (typeof vault?.get === "function") {
    const value = await vault.get(vaultRef);
    if (nonEmptyString(value)) return value as string;
  }
  return undefined;
}

function credentialRefsFromUnknown(value: unknown): SpotifyCredentialRefRecordLike[] {
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
      const ref = credentialRefFromRecord({ credentialType, ...entryRecord });
      return ref ? [ref] : [];
    }
    const vaultRef = nonEmptyString(entry);
    return vaultRef ? [{ credentialType, vaultRef }] : [];
  });
}

function credentialRefFromRecord(
  record: JsonRecord | undefined
): SpotifyCredentialRefRecordLike | null {
  if (!record) return null;
  const credentialType = nonEmptyString(record.credentialType ?? record.type ?? record.name);
  const vaultRef = nonEmptyString(record.vaultRef ?? record.ref);
  if (!credentialType || !vaultRef) return null;
  return {
    credentialType,
    vaultRef,
    metadata: asRecord(record.metadata) ?? null,
    expiresAt: record.expiresAt as SpotifyCredentialRefRecordLike["expiresAt"],
  };
}

function resolveVaultWriters(runtime: IAgentRuntime, params: PersistParams): VaultWriter[] {
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
          provider: params.provider,
          accountId: params.accountId,
          credentialType: credential.credentialType,
          value: credential.value,
          caller: params.caller,
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
        await vault.set?.(vaultRef, credential.value, { sensitive: true, caller: params.caller });
        return vaultRef;
      },
    });
  }
  return writers;
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
    const fn = writer.setConnectorAccountCredentialRef ?? writer.setCredentialRef;
    if (typeof fn === "function") {
      writers.push({
        name:
          typeof writer.setConnectorAccountCredentialRef === "function"
            ? "setConnectorAccountCredentialRef"
            : "setCredentialRef",
        write: async (ref) => {
          await fn.call(writer, {
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
  credential: CredentialInput
): Promise<string> {
  const errors: string[] = [];
  for (const writer of writers) {
    try {
      return await writer.write(plannedRef, credential);
    } catch (error) {
      // error-policy:J2 collect per-writer failures; the aggregate rethrows below.
      errors.push(`${writer.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Failed to persist connector credential ref ${plannedRef}: ${errors.join("; ")}`);
}

async function writeRefsToStorage(
  writers: CredentialRefWriter[],
  refs: SpotifyCredentialRefMetadata[]
): Promise<void> {
  const errors: string[] = [];
  for (const writer of writers) {
    try {
      for (const ref of refs) {
        await writer.write(ref);
      }
      return;
    } catch (error) {
      // error-policy:J2 collect per-writer failures; the aggregate rethrows below.
      errors.push(`${writer.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Failed to persist connector credential refs: ${errors.join("; ")}`);
}

function buildVaultRef(params: {
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
    // error-policy:J3 a runtime without a service registry means "not available".
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
