/**
 * Reads and writes X OAuth token sets against the core ConnectorAccountManager's
 * credential store, so OAuth 2.0 tokens survive restarts alongside the connector
 * account record. The persistence backend behind `ConnectorAccountTokenStore`
 * (`client/auth-providers/token-store.ts`).
 */
import {
  CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE,
  type ConnectorAccount,
  getConnectorAccountManager,
  type IAgentRuntime,
  writeConnectorCredentialRefMetadata,
  writeConnectorCredentialSecret,
} from "@elizaos/core";

export type {
  ConnectorCredentialPersistResult,
  ConnectorCredentialRefMetadata,
} from "@elizaos/core";
export { persistConnectorCredentialRefs } from "@elizaos/core";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { readonly [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;

export const OAUTH_TOKENS_CREDENTIAL_TYPE = "oauth.tokens";

export interface ConnectorCredentialRefRecordLike {
  credentialType: string;
  vaultRef?: string | null;
  value?: string | null;
  metadata?: JsonRecord | null;
  expiresAt?: number | string | Date | null;
  updatedAt?: number | string | Date | null;
  version?: string | number | null;
}

export async function loadConnectorOAuthTokenSet(params: {
  runtime: IAgentRuntime;
  provider: string;
  accountId: string;
  caller: string;
}): Promise<JsonRecord | null> {
  const { records } = await loadConnectorCredentialRecords(params);
  const tokenRecord = records.find((record) =>
    sameCredentialType(record.credentialType, OAUTH_TOKENS_CREDENTIAL_TYPE),
  );
  if (!tokenRecord) return null;
  const raw =
    nonEmptyString(tokenRecord.value) ??
    (tokenRecord.vaultRef
      ? await readCredentialSecret(
          params.runtime,
          tokenRecord.vaultRef,
          params.caller,
        )
      : undefined);
  const parsed = raw ? parseMaybeJson(raw) : undefined;
  return asRecord(parsed) ?? null;
}

export async function saveConnectorOAuthTokenSet(params: {
  runtime: IAgentRuntime;
  provider: string;
  accountId: string;
  value: string;
  expiresAt?: number;
  caller: string;
}): Promise<boolean> {
  const { account, records } = await loadConnectorCredentialRecords(params);
  if (!account) return false;
  const tokenRecord = records.find((record) =>
    sameCredentialType(record.credentialType, OAUTH_TOKENS_CREDENTIAL_TYPE),
  );
  if (!tokenRecord?.vaultRef) return false;

  await writeConnectorCredentialSecret({
    runtime: params.runtime,
    vaultRef: tokenRecord.vaultRef,
    credential: {
      credentialType: OAUTH_TOKENS_CREDENTIAL_TYPE,
      value: params.value,
      ...(params.expiresAt !== undefined
        ? { expiresAt: params.expiresAt }
        : {}),
    },
    provider: params.provider,
    accountId: account.id,
    caller: params.caller,
  });

  await writeConnectorCredentialRefMetadata({
    runtime: params.runtime,
    storageAccountId: account.id,
    refs: [
      {
        credentialType: OAUTH_TOKENS_CREDENTIAL_TYPE,
        vaultRef: tokenRecord.vaultRef,
        ...(params.expiresAt !== undefined
          ? { expiresAt: params.expiresAt }
          : {}),
      },
    ],
  });
  return true;
}

export async function getConnectorAccount(
  runtime: IAgentRuntime,
  provider: string,
  accountId: string,
): Promise<ConnectorAccount | null> {
  try {
    const manager = getConnectorAccountManager(runtime);
    const account = await manager.getAccount(provider, accountId);
    if (account) return account;
  } catch {
    // error-policy:J4 Manager absence falls back to the explicit storage boundary.
  }

  const storage = getService(
    runtime,
    CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE,
  ) as {
    getAccount?: (
      provider: string,
      accountId: string,
    ) => Promise<ConnectorAccount | null>;
  } | null;
  if (typeof storage?.getAccount === "function") {
    return storage.getAccount(provider, accountId);
  }
  return null;
}

export function credentialRefRecordsFromMetadata(
  metadata: unknown,
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

async function loadConnectorCredentialRecords(params: {
  runtime: IAgentRuntime;
  provider: string;
  accountId: string;
}): Promise<{
  account: ConnectorAccount | null;
  records: ConnectorCredentialRefRecordLike[];
}> {
  const account = await getConnectorAccount(
    params.runtime,
    params.provider,
    params.accountId,
  );
  if (!account) return { account: null, records: [] };
  const records = [...credentialRefRecordsFromMetadata(account.metadata)];

  for (const source of [
    getService(params.runtime, CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE),
    params.runtime.adapter,
  ]) {
    const reader = source as
      | {
          listConnectorAccountCredentialRefs?: (args: {
            accountId: string;
          }) => Promise<ConnectorCredentialRefRecordLike[]>;
          getConnectorAccountCredentialRef?: (args: {
            accountId: string;
            credentialType: string;
          }) => Promise<ConnectorCredentialRefRecordLike | null>;
        }
      | null
      | undefined;
    if (typeof reader?.listConnectorAccountCredentialRefs === "function") {
      records.push(
        ...(await reader.listConnectorAccountCredentialRefs({
          accountId: account.id,
        })),
      );
    } else if (typeof reader?.getConnectorAccountCredentialRef === "function") {
      const ref = await reader.getConnectorAccountCredentialRef({
        accountId: account.id,
        credentialType: OAUTH_TOKENS_CREDENTIAL_TYPE,
      });
      if (ref) records.push(ref);
    }
  }

  return { account, records };
}

function credentialRefsFromUnknown(
  value: unknown,
): ConnectorCredentialRefRecordLike[] {
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
  record: JsonRecord | undefined,
): ConnectorCredentialRefRecordLike | null {
  if (!record) return null;
  const credentialType = nonEmptyString(
    record.credentialType ?? record.type ?? record.name,
  );
  const vaultRef = nonEmptyString(record.vaultRef ?? record.ref);
  if (!credentialType || !vaultRef) return null;
  return {
    credentialType,
    vaultRef,
    metadata: asRecord(record.metadata) ?? null,
    expiresAt:
      record.expiresAt as ConnectorCredentialRefRecordLike["expiresAt"],
    updatedAt:
      record.updatedAt as ConnectorCredentialRefRecordLike["updatedAt"],
    version: (record.version ??
      record.credentialVersion) as ConnectorCredentialRefRecordLike["version"],
  };
}

async function readCredentialSecret(
  runtime: IAgentRuntime,
  vaultRef: string,
  caller: string,
): Promise<string | undefined> {
  for (const reader of resolveSecretReaders(runtime)) {
    try {
      const value = await readSecret(reader, vaultRef, caller, runtime);
      const trimmed = nonEmptyString(value);
      if (trimmed) return trimmed;
    } catch {
      // error-policy:J4 One unavailable reader falls back to the next durable reader.
    }
  }
  return undefined;
}

function resolveSecretReaders(runtime: IAgentRuntime): unknown[] {
  return [
    getFirstService(runtime, [
      "connector_credential_store",
      "CONNECTOR_CREDENTIAL_STORE",
      "connectorCredentialStore",
      "credential_store",
    ]),
    getFirstService(runtime, ["vault", "VAULT"]),
    getService(runtime, "SECRETS"),
  ].filter(Boolean);
}

async function readSecret(
  reader: unknown,
  vaultRef: string,
  caller: string,
  runtime: IAgentRuntime,
): Promise<string | null> {
  const candidate = reader as {
    reveal?: (key: string, caller?: string) => Promise<string> | string;
    get?: (
      key: string,
      optionsOrContext?: { reveal?: boolean; caller?: string } | JsonRecord,
    ) => Promise<string | null> | string | null;
  };
  if (typeof candidate.reveal === "function") {
    return candidate.reveal(vaultRef, caller);
  }
  if (typeof candidate.get !== "function") return null;
  if (
    reader &&
    (reader as { constructor?: { name?: string } }).constructor?.name ===
      "SecretsService"
  ) {
    return candidate.get(vaultRef, {
      level: "global",
      agentId: runtime.agentId,
      requesterId: runtime.agentId,
    });
  }
  return candidate.get(vaultRef, { reveal: true, caller });
}

function sameCredentialType(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function parseMaybeJson(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // error-policy:J3 Malformed credential payloads are rejected as absent.
    return undefined;
  }
}

function getFirstService(
  runtime: IAgentRuntime,
  serviceTypes: readonly string[],
): unknown {
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
    // error-policy:J3 Unknown service names are an explicit unavailable probe.
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
