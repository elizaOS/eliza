/**
 * `DefaultNotionCredentialResolver` — turns a stored Notion connector account
 * into a bearer token. Resolution order: explicit BYO `NOTION_TOKEN` setting
 * (local/self-hosted mode, `accountId` "default" or "local"), then the
 * connector account's credential refs (metadata-embedded values first, then
 * connector-account storage records, then vault refs read through the runtime's
 * credential store / vault / secrets services). Notion access tokens do not
 * expire, so there is no refresh path; a revoked token surfaces as
 * `NOTION_AUTH_EXPIRED` from the client and requires re-connecting.
 */
import {
  CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE,
  type ConnectorAccount,
  ElizaError,
  getConnectorAccountManager,
  type IAgentRuntime,
} from "@elizaos/core";
import {
  NOTION_SERVICE_NAME,
  type NotionAccountRef,
  type NotionCredentialResolver,
  type NotionResolvedCredential,
} from "./types.js";

const BYO_TOKEN_SETTING = "NOTION_TOKEN";
const BYO_ACCOUNT_IDS = new Set(["default", "local"]);
const TOKEN_CREDENTIAL_TYPES = [
  "oauth.tokens",
  "oauth.access_token",
  "oauth.accessToken",
  "access_token",
  "accessToken",
];

type JsonRecord = Record<string, unknown>;

interface CredentialRefRecord {
  credentialType: string;
  value?: string | null;
  token?: string | null;
  secret?: string | null;
  vaultRef?: string | null;
}

export class DefaultNotionCredentialResolver implements NotionCredentialResolver {
  constructor(private readonly runtime?: IAgentRuntime | null) {}

  async getCredential(request: NotionAccountRef): Promise<NotionResolvedCredential> {
    const byoToken = this.readSetting(BYO_TOKEN_SETTING);
    if (byoToken && BYO_ACCOUNT_IDS.has(request.accountId)) {
      return { accessToken: byoToken };
    }

    const account = await this.getAccount(request.accountId);
    if (!account) {
      throw new ElizaError(
        `DefaultNotionCredentialResolver: Notion account ${request.accountId} was not found` +
          " and no NOTION_TOKEN is configured for local mode.",
        { code: "NOTION_ACCOUNT_NOT_FOUND", context: { accountId: request.accountId } }
      );
    }
    if (account.status !== "connected") {
      throw new ElizaError(
        `DefaultNotionCredentialResolver: Notion account ${request.accountId} is ${account.status}, not connected.`,
        {
          code: "NOTION_ACCOUNT_NOT_CONNECTED",
          context: { accountId: request.accountId, status: account.status },
        }
      );
    }

    const accessToken = await this.resolveAccessToken(account);
    if (!accessToken) {
      throw new ElizaError(
        `DefaultNotionCredentialResolver: no access token is stored for Notion account ${request.accountId}.`,
        { code: "NOTION_CREDENTIAL_MISSING", context: { accountId: request.accountId } }
      );
    }

    const metadata = asRecord(account.metadata);
    return {
      accessToken,
      workspaceId: readString(metadata, "workspaceId"),
      botId: readString(metadata, "botId"),
    };
  }

  private async getAccount(accountId: string): Promise<ConnectorAccount | null> {
    const manager = this.runtime ? getConnectorAccountManager(this.runtime) : null;
    if (!manager) return null;
    const direct = await manager.getAccount(NOTION_SERVICE_NAME, accountId);
    if (direct) return direct;
    if (BYO_ACCOUNT_IDS.has(accountId)) {
      const connected = (await manager.listAccounts(NOTION_SERVICE_NAME)).filter(
        (account) => account.status === "connected"
      );
      if (connected.length === 1) return connected[0];
    }
    return null;
  }

  private async resolveAccessToken(account: ConnectorAccount): Promise<string | undefined> {
    for (const record of credentialRecordsFromMetadata(account.metadata)) {
      const token = await this.tokenFromRecord(record);
      if (token) return token;
    }
    for (const record of await this.loadStorageRecords(account.id)) {
      const token = await this.tokenFromRecord(record);
      if (token) return token;
    }
    return undefined;
  }

  private async loadStorageRecords(accountId: string): Promise<CredentialRefRecord[]> {
    const storage = this.resolveStorage();
    if (!storage) return [];
    if (typeof storage.listConnectorAccountCredentialRefs === "function") {
      return storage.listConnectorAccountCredentialRefs({ accountId });
    }
    if (typeof storage.getConnectorAccountCredentialRef !== "function") return [];
    const records: CredentialRefRecord[] = [];
    for (const credentialType of TOKEN_CREDENTIAL_TYPES) {
      const record = await storage.getConnectorAccountCredentialRef({ accountId, credentialType });
      if (record) records.push(record);
    }
    return records;
  }

  private resolveStorage(): {
    listConnectorAccountCredentialRefs?: (params: {
      accountId: string;
    }) => Promise<CredentialRefRecord[]>;
    getConnectorAccountCredentialRef?: (params: {
      accountId: string;
      credentialType: string;
    }) => Promise<CredentialRefRecord | null>;
  } | null {
    if (!this.runtime) return null;
    const service = safelyGetService(this.runtime, CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE);
    if (isRecordLike(service)) return service;
    const manager = getConnectorAccountManager(this.runtime);
    const storage = manager?.getStorage();
    return isRecordLike(storage) ? storage : null;
  }

  private async tokenFromRecord(record: CredentialRefRecord): Promise<string | undefined> {
    if (
      !TOKEN_CREDENTIAL_TYPES.some((t) => t.toLowerCase() === record.credentialType.toLowerCase())
    ) {
      return undefined;
    }
    const raw =
      nonEmptyString(record.value) ??
      nonEmptyString(record.token) ??
      nonEmptyString(record.secret) ??
      (record.vaultRef ? await this.readVaultRef(record.vaultRef) : undefined);
    if (!raw) return undefined;
    return accessTokenFromValue(raw);
  }

  private async readVaultRef(vaultRef: string): Promise<string | undefined> {
    if (!this.runtime) return undefined;
    for (const serviceType of ["connector-credential-store", "vault", "secrets"]) {
      const service = safelyGetService(this.runtime, serviceType) as {
        reveal?: (key: string, caller?: string) => Promise<string> | string;
        get?: (
          key: string,
          options?: { reveal?: boolean; caller?: string } | JsonRecord
        ) => Promise<string | null> | string | null;
      } | null;
      if (!service) continue;
      // error-policy:J4 an individual store missing/failing this ref is an
      // expected miss; the caller reports CREDENTIAL_MISSING when all miss.
      try {
        if (typeof service.reveal === "function") {
          const value = nonEmptyString(await service.reveal(vaultRef, "plugin-notion"));
          if (value) return value;
        } else if (typeof service.get === "function") {
          const value = nonEmptyString(
            await service.get(vaultRef, { reveal: true, caller: "plugin-notion" })
          );
          if (value) return value;
        }
      } catch {
        // continue to the next reader
      }
    }
    return undefined;
  }

  private readSetting(key: string): string | undefined {
    return nonEmptyString(this.runtime?.getSetting?.(key));
  }
}

/** Extracts the access token whether the value is raw or a persisted token-set JSON. */
export function accessTokenFromValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  // error-policy:J3 a persisted token-set that fails to parse is treated as a
  // raw token rather than fabricating credentials from a broken blob.
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecordValue(parsed)) {
      return nonEmptyString(parsed.access_token) ?? nonEmptyString(parsed.accessToken);
    }
  } catch {
    return trimmed;
  }
  return undefined;
}

function credentialRecordsFromMetadata(metadata: unknown): CredentialRefRecord[] {
  const refs = asRecord(metadata)?.credentialRefs;
  if (!Array.isArray(refs)) return [];
  return refs.filter(
    (ref): ref is CredentialRefRecord =>
      isRecordValue(ref) && typeof ref.credentialType === "string"
  );
}

function safelyGetService(runtime: IAgentRuntime, serviceType: string): unknown {
  // error-policy:J4 a missing optional storage/vault service is a designed
  // absence; resolution continues down the fallback chain.
  try {
    return runtime.getService(serviceType);
  } catch {
    return null;
  }
}

function isRecordLike(value: unknown): value is {
  listConnectorAccountCredentialRefs?: (params: {
    accountId: string;
  }) => Promise<CredentialRefRecord[]>;
  getConnectorAccountCredentialRef?: (params: {
    accountId: string;
    credentialType: string;
  }) => Promise<CredentialRefRecord | null>;
} {
  return (
    isRecordValue(value) &&
    (typeof value.listConnectorAccountCredentialRefs === "function" ||
      typeof value.getConnectorAccountCredentialRef === "function")
  );
}

function isRecordValue(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecordValue(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readString(record: JsonRecord | undefined, key: string): string | undefined {
  return record ? nonEmptyString(record[key]) : undefined;
}
