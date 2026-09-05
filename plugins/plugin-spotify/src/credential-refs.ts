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
  CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPES,
  CONNECTOR_VAULT_SERVICE_TYPES,
  type ConnectorAccountManager,
  type ConnectorCredentialInput,
  type ConnectorCredentialRefMetadata,
  type IAgentRuntime,
  persistConnectorCredentialRefs,
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

export type SpotifyCredentialRefMetadata = ConnectorCredentialRefMetadata;

export interface SpotifyCredentialRefRecordLike {
  credentialType: string;
  vaultRef?: string | null;
  metadata?: JsonRecord | null;
  expiresAt?: number | string | Date | null;
}

interface PersistParams {
  runtime: IAgentRuntime;
  manager?: ConnectorAccountManager;
  provider: string;
  accountId: string;
  credentials: ConnectorCredentialInput[];
  caller: string;
}

export interface SpotifyCredentialPersistResult {
  refs: SpotifyCredentialRefMetadata[];
}

export async function persistSpotifyCredentialRefs(
  params: PersistParams
): Promise<SpotifyCredentialPersistResult> {
  const { refs } = await persistConnectorCredentialRefs({
    runtime: params.runtime,
    manager: params.manager,
    provider: params.provider,
    accountIdForRef: params.accountId,
    storageAccountId: params.accountId,
    credentials: params.credentials,
    caller: params.caller,
  });
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
