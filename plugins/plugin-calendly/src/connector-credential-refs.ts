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

export interface ConnectorCredentialRefMetadata extends JsonRecord {
  credentialType: string;
  vaultRef: string;
  expiresAt?: number;
  metadata?: JsonRecord;
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
): Promise<{
  refs: ConnectorCredentialRefMetadata[];
  vaultAvailable: boolean;
  storageAvailable: boolean;
}> {
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
