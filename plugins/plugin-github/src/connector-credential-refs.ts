import {
  CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE,
  type ConnectorAccount,
  type ConnectorAccountManager,
  getConnectorAccountManager,
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

export const OAUTH_TOKENS_CREDENTIAL_TYPE = "oauth.tokens";

export interface ConnectorCredentialRefMetadata extends JsonRecord {
  credentialType: string;
  vaultRef: string;
  expiresAt?: number;
  metadata?: JsonRecord;
}

export interface ConnectorCredentialRefRecordLike {
  credentialType: string;
  vaultRef?: string | null;
  value?: string | null;
  metadata?: JsonRecord | null;
  expiresAt?: number | string | Date | null;
  updatedAt?: number | string | Date | null;
  version?: string | number | null;
}

export interface ConnectorCredentialPersistResult {
  refs: ConnectorCredentialRefMetadata[];
  vaultAvailable: boolean;
  storageAvailable: boolean;
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
  write: (
    vaultRef: string,
    credential: ConnectorCredentialInput,
  ) => Promise<string>;
};

type CredentialRefWriter = {
  name: string;
  write: (ref: ConnectorCredentialRefMetadata) => Promise<void>;
};

export async function persistConnectorCredentialRefs(
  params: PersistConnectorCredentialRefsParams,
): Promise<ConnectorCredentialPersistResult> {
  const refs: ConnectorCredentialRefMetadata[] = [];
  const vaultWriters = resolveVaultWriters(params.runtime, {
    provider: params.provider,
    accountId: params.accountIdForRef,
    caller: params.caller,
  });
  if (vaultWriters.length === 0) {
    throw new Error(
      `No durable connector credential store or vault writer is available for ${params.provider} account ${params.accountIdForRef}. Refusing to mark OAuth account connected without persisted credentials.`,
    );
  }
  if (!params.storageAccountId) {
    throw new Error(
      `No durable connector account id is available for ${params.provider} account ${params.accountIdForRef}. Refusing to mark OAuth account connected without persisted credential refs.`,
    );
  }
  const storageWriters = resolveCredentialRefWriters(
    params.runtime,
    params.manager,
    params.storageAccountId,
  );
  if (storageWriters.length === 0) {
    throw new Error(
      `No durable connector credential ref writer is available for ${params.provider} account ${params.storageAccountId}. Refusing to mark OAuth account connected without persisted credential refs.`,
    );
  }

  for (const credential of params.credentials) {
    const plannedRef = buildConnectorCredentialVaultRef({
      agentId: nonEmptyString(params.runtime.agentId) ?? "agent",
      provider: params.provider,
      accountId: params.accountIdForRef,
      credentialType: credential.credentialType,
    });
    const vaultRef = await writeWithFirstAvailableVault(
      vaultWriters,
      plannedRef,
      credential,
    );
    refs.push({
      credentialType: credential.credentialType,
      vaultRef,
      ...(credential.expiresAt !== undefined
        ? { expiresAt: credential.expiresAt }
        : {}),
      ...(credential.metadata ? { metadata: credential.metadata } : {}),
    });
  }

  if (refs.length > 0) {
    await writeRefsToStorage(storageWriters, refs);
  }

  return {
    refs,
    vaultAvailable: vaultWriters.length > 0,
    storageAvailable: storageWriters.length > 0,
  };
}

export async function loadConnectorOAuthAccessToken(params: {
  runtime: IAgentRuntime;
  provider: string;
  accountId: string;
  caller: string;
}): Promise<string | null> {
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
  const tokenSet = asRecord(parsed);
  return nonEmptyString(tokenSet?.access_token) ?? null;
}

export async function listConnectorAccounts(
  runtime: IAgentRuntime,
  provider: string,
): Promise<ConnectorAccount[]> {
  try {
    return await getConnectorAccountManager(runtime).listAccounts(provider);
  } catch {
    const storage = getService(
      runtime,
      CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE,
    ) as {
      listAccounts?: (provider?: string) => Promise<ConnectorAccount[]>;
    } | null;
    if (typeof storage?.listAccounts === "function") {
      return storage.listAccounts(provider);
    }
  }
  return [];
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
  records: ConnectorCredentialRefRecordLike[];
}> {
  const accounts = await listConnectorAccounts(params.runtime, params.provider);
  const account = accounts.find(
    (candidate) =>
      candidate.id === params.accountId ||
      candidate.externalId === params.accountId ||
      candidate.displayHandle === params.accountId,
  );
  if (!account) return { records: [] };
  const records = [...credentialRefRecordsFromMetadata(account.metadata)];

  for (const source of [
    getService(params.runtime, CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE),
    (params.runtime as { adapter?: unknown }).adapter,
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

  return { records };
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
      // Try the next available reader.
    }
  }
  return undefined;
}

function resolveVaultWriters(
  runtime: IAgentRuntime,
  context: { provider: string; accountId: string; caller: string },
): VaultWriter[] {
  const writers: VaultWriter[] = [];
  const credentialStore = getFirstService(runtime, [
    "connector_credential_store",
    "CONNECTOR_CREDENTIAL_STORE",
    "connectorCredentialStore",
    "credential_store",
  ]) as {
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

  const vault = getFirstService(runtime, ["vault", "VAULT"]) as {
    set?: (
      key: string,
      value: string,
      options?: { sensitive?: boolean; caller?: string },
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

  const secrets = getService(runtime, "SECRETS") as {
    setGlobal?: (
      key: string,
      value: string,
      config?: { sensitive?: boolean },
    ) => Promise<boolean> | boolean;
    set?: (
      key: string,
      value: string,
      context: JsonRecord,
      config?: { sensitive?: boolean },
    ) => Promise<boolean> | boolean;
  } | null;
  if (
    typeof secrets?.setGlobal === "function" ||
    typeof secrets?.set === "function"
  ) {
    writers.push({
      name: "SECRETS",
      write: async (vaultRef, credential) => {
        if (typeof secrets.setGlobal === "function") {
          await secrets.setGlobal(vaultRef, credential.value, {
            sensitive: true,
          });
          return vaultRef;
        }
        await secrets.set?.(
          vaultRef,
          credential.value,
          { level: "global", agentId: runtime.agentId },
          { sensitive: true },
        );
        return vaultRef;
      },
    });
  }
  return writers;
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
    });
  }
  return candidate.get(vaultRef, { reveal: true, caller });
}

function resolveCredentialRefWriters(
  runtime: IAgentRuntime,
  manager: ConnectorAccountManager | undefined,
  accountId: string,
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
            ...(ref.expiresAt !== undefined
              ? { expiresAt: ref.expiresAt }
              : {}),
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
            ...(ref.expiresAt !== undefined
              ? { expiresAt: ref.expiresAt }
              : {}),
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
  credential: ConnectorCredentialInput,
): Promise<string> {
  const errors: string[] = [];
  for (const writer of writers) {
    try {
      return await writer.write(plannedRef, credential);
    } catch (error) {
      errors.push(
        `${writer.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    `Failed to persist connector credential ref ${plannedRef}: ${errors.join("; ")}`,
  );
}

async function writeRefsToStorage(
  writers: CredentialRefWriter[],
  refs: ConnectorCredentialRefMetadata[],
): Promise<void> {
  const errors: string[] = [];
  for (const writer of writers) {
    try {
      for (const ref of refs) {
        await writer.write(ref);
      }
      return;
    } catch (error) {
      errors.push(
        `${writer.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    `Failed to persist connector credential refs: ${errors.join("; ")}`,
  );
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

function sameCredentialType(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function parseMaybeJson(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
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
