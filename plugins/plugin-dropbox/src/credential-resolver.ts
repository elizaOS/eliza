/**
 * `DefaultDropboxCredentialResolver` — turns a stored Dropbox connector account
 * into a live bearer token. Resolution order: explicit BYO
 * `DROPBOX_ACCESS_TOKEN` setting (local/self-hosted mode, `accountId`
 * "default" or "local"), then the connector account's credential refs
 * (metadata-embedded values first, then connector-account storage records,
 * then vault refs read through the runtime's credential store / vault /
 * secrets services).
 *
 * Dropbox access tokens are short-lived: when the stored token set carries an
 * expiry within the refresh skew and a refresh token, the resolver performs the
 * OAuth refresh grant against the token endpoint (mock-overridable via
 * `ELIZA_MOCK_DROPBOX_BASE`) and caches the refreshed token in memory until it
 * expires. A refresh rejection surfaces as `DROPBOX_AUTH_EXPIRED` so callers
 * prompt for reconnection instead of retrying forever.
 */
import {
  CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE,
  type ConnectorAccount,
  ElizaError,
  getConnectorAccountManager,
  type IAgentRuntime,
} from "@elizaos/core";
import {
  DROPBOX_SERVICE_NAME,
  type DropboxAccountRef,
  type DropboxCredentialResolver,
  type DropboxResolvedCredential,
} from "./types.js";

const BYO_TOKEN_SETTING = "DROPBOX_ACCESS_TOKEN";
const BYO_ACCOUNT_IDS = new Set(["default", "local"]);
const TOKEN_CREDENTIAL_TYPES = [
  "oauth.tokens",
  "oauth.access_token",
  "oauth.accessToken",
  "access_token",
  "accessToken",
];
/** Refresh this long before the recorded expiry to absorb clock skew. */
const REFRESH_SKEW_MS = 60_000;
export const DROPBOX_TOKEN_ENDPOINT_PATH = "/oauth2/token";
const DROPBOX_DEFAULT_API_BASE = "https://api.dropboxapi.com";

type JsonRecord = Record<string, unknown>;

interface CredentialRefRecord {
  credentialType: string;
  value?: string | null;
  token?: string | null;
  secret?: string | null;
  vaultRef?: string | null;
}

interface DropboxTokenSet {
  accessToken?: string;
  refreshToken?: string;
  expiryDate?: number;
  dropboxAccountId?: string;
}

export interface DefaultDropboxCredentialResolverOptions {
  fetchImpl?: typeof fetch;
  tokenEndpoint?: string;
  now?: () => number;
}

export class DefaultDropboxCredentialResolver implements DropboxCredentialResolver {
  private readonly fetchImpl: typeof fetch;
  private readonly tokenEndpoint: string;
  private readonly now: () => number;
  private readonly refreshed = new Map<string, { accessToken: string; expiryDate: number }>();

  constructor(
    private readonly runtime?: IAgentRuntime | null,
    options: DefaultDropboxCredentialResolverOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.tokenEndpoint =
      options.tokenEndpoint ??
      `${(process.env.ELIZA_MOCK_DROPBOX_BASE ?? DROPBOX_DEFAULT_API_BASE).replace(/\/$/, "")}${DROPBOX_TOKEN_ENDPOINT_PATH}`;
    this.now = options.now ?? Date.now;
  }

  async getCredential(request: DropboxAccountRef): Promise<DropboxResolvedCredential> {
    const byoToken = nonEmptyString(this.runtime?.getSetting?.(BYO_TOKEN_SETTING));
    if (byoToken && BYO_ACCOUNT_IDS.has(request.accountId)) {
      return { accessToken: byoToken };
    }

    const account = await this.getAccount(request.accountId);
    if (!account) {
      throw new ElizaError(
        `DefaultDropboxCredentialResolver: Dropbox account ${request.accountId} was not found` +
          " and no DROPBOX_ACCESS_TOKEN is configured for local mode.",
        { code: "DROPBOX_ACCOUNT_NOT_FOUND", context: { accountId: request.accountId } }
      );
    }
    if (account.status !== "connected") {
      throw new ElizaError(
        `DefaultDropboxCredentialResolver: Dropbox account ${request.accountId} is ${account.status}, not connected.`,
        {
          code: "DROPBOX_ACCOUNT_NOT_CONNECTED",
          context: { accountId: request.accountId, status: account.status },
        }
      );
    }

    const tokenSet = await this.resolveTokenSet(account);
    if (!tokenSet.accessToken && !tokenSet.refreshToken) {
      throw new ElizaError(
        `DefaultDropboxCredentialResolver: no token material is stored for Dropbox account ${request.accountId}.`,
        { code: "DROPBOX_CREDENTIAL_MISSING", context: { accountId: request.accountId } }
      );
    }

    const cached = this.refreshed.get(account.id);
    if (cached && cached.expiryDate - REFRESH_SKEW_MS > this.now()) {
      return { accessToken: cached.accessToken, dropboxAccountId: tokenSet.dropboxAccountId };
    }

    const expired =
      typeof tokenSet.expiryDate === "number" &&
      tokenSet.expiryDate - REFRESH_SKEW_MS <= this.now();
    if ((expired || !tokenSet.accessToken) && tokenSet.refreshToken) {
      const refreshedToken = await this.refreshAccessToken(account, tokenSet.refreshToken);
      this.refreshed.set(account.id, refreshedToken);
      return {
        accessToken: refreshedToken.accessToken,
        dropboxAccountId: tokenSet.dropboxAccountId,
      };
    }
    if (!tokenSet.accessToken) {
      throw new ElizaError(
        `DefaultDropboxCredentialResolver: Dropbox account ${request.accountId} has no usable access token.`,
        { code: "DROPBOX_CREDENTIAL_MISSING", context: { accountId: request.accountId } }
      );
    }
    return { accessToken: tokenSet.accessToken, dropboxAccountId: tokenSet.dropboxAccountId };
  }

  clearCache(accountId?: string): void {
    if (accountId) {
      this.refreshed.delete(accountId);
    } else {
      this.refreshed.clear();
    }
  }

  private async refreshAccessToken(
    account: ConnectorAccount,
    refreshToken: string
  ): Promise<{ accessToken: string; expiryDate: number }> {
    const clientId = nonEmptyString(this.runtime?.getSetting?.("DROPBOX_CLIENT_ID"));
    const clientSecret = nonEmptyString(this.runtime?.getSetting?.("DROPBOX_CLIENT_SECRET"));
    if (!clientId || !clientSecret) {
      throw new ElizaError(
        "DefaultDropboxCredentialResolver: a Dropbox refresh token is available, but DROPBOX_CLIENT_ID and DROPBOX_CLIENT_SECRET are not configured for token refresh.",
        { code: "DROPBOX_OAUTH_NOT_CONFIGURED", context: { accountId: account.id } }
      );
    }
    const response = await this.fetchImpl(this.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new ElizaError(
        `DefaultDropboxCredentialResolver: Dropbox token refresh failed with ${response.status}; reconnect the account.`,
        {
          code: "DROPBOX_AUTH_EXPIRED",
          context: { accountId: account.id, status: response.status },
        }
      );
    }
    const parsed = (await response.json().catch(() => null)) as {
      access_token?: string;
      expires_in?: number;
    } | null;
    const accessToken = nonEmptyString(parsed?.access_token);
    if (!accessToken || typeof parsed?.expires_in !== "number") {
      throw new ElizaError(
        "DefaultDropboxCredentialResolver: Dropbox token refresh returned an invalid payload.",
        { code: "DROPBOX_MALFORMED_RESPONSE", context: { accountId: account.id } }
      );
    }
    return { accessToken, expiryDate: this.now() + parsed.expires_in * 1000 };
  }

  private async getAccount(accountId: string): Promise<ConnectorAccount | null> {
    const manager = this.runtime ? getConnectorAccountManager(this.runtime) : null;
    if (!manager) return null;
    const direct = await manager.getAccount(DROPBOX_SERVICE_NAME, accountId);
    if (direct) return direct;
    if (BYO_ACCOUNT_IDS.has(accountId)) {
      const connected = (await manager.listAccounts(DROPBOX_SERVICE_NAME)).filter(
        (account) => account.status === "connected"
      );
      if (connected.length === 1) return connected[0];
    }
    return null;
  }

  private async resolveTokenSet(account: ConnectorAccount): Promise<DropboxTokenSet> {
    const merged: DropboxTokenSet = {};
    for (const record of credentialRecordsFromMetadata(account.metadata)) {
      mergeTokenSet(merged, await this.valueFromRecord(record));
    }
    if (!merged.accessToken && !merged.refreshToken) {
      for (const record of await this.loadStorageRecords(account.id)) {
        mergeTokenSet(merged, await this.valueFromRecord(record));
      }
    }
    return merged;
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
    if (isStorageLike(service)) return service;
    const manager = getConnectorAccountManager(this.runtime);
    const storage = manager?.getStorage();
    return isStorageLike(storage) ? storage : null;
  }

  private async valueFromRecord(record: CredentialRefRecord): Promise<string | undefined> {
    if (
      !TOKEN_CREDENTIAL_TYPES.some((t) => t.toLowerCase() === record.credentialType.toLowerCase())
    ) {
      return undefined;
    }
    return (
      nonEmptyString(record.value) ??
      nonEmptyString(record.token) ??
      nonEmptyString(record.secret) ??
      (record.vaultRef ? await this.readVaultRef(record.vaultRef) : undefined)
    );
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
          const value = nonEmptyString(await service.reveal(vaultRef, "plugin-dropbox"));
          if (value) return value;
        } else if (typeof service.get === "function") {
          const value = nonEmptyString(
            await service.get(vaultRef, { reveal: true, caller: "plugin-dropbox" })
          );
          if (value) return value;
        }
      } catch {
        // continue to the next reader
      }
    }
    return undefined;
  }
}

function mergeTokenSet(target: DropboxTokenSet, raw: string | undefined): void {
  if (!raw) return;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    target.accessToken ??= trimmed;
    return;
  }
  // error-policy:J3 a persisted token-set that fails to parse contributes
  // nothing rather than fabricating credentials from a broken blob.
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const record = parsed as JsonRecord;
  target.accessToken ??= nonEmptyString(record.access_token) ?? nonEmptyString(record.accessToken);
  target.refreshToken ??=
    nonEmptyString(record.refresh_token) ?? nonEmptyString(record.refreshToken);
  target.dropboxAccountId ??= nonEmptyString(record.account_id) ?? nonEmptyString(record.accountId);
  if (target.expiryDate === undefined) {
    const expiry = record.expiry_date ?? record.expiryDate ?? record.expires_at;
    if (typeof expiry === "number" && Number.isFinite(expiry)) {
      target.expiryDate = expiry;
    }
  }
}

function credentialRecordsFromMetadata(metadata: unknown): CredentialRefRecord[] {
  const record =
    metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as JsonRecord)
      : undefined;
  const refs = record?.credentialRefs;
  if (!Array.isArray(refs)) return [];
  return refs.filter(
    (ref): ref is CredentialRefRecord =>
      ref !== null &&
      typeof ref === "object" &&
      !Array.isArray(ref) &&
      typeof (ref as JsonRecord).credentialType === "string"
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

function isStorageLike(value: unknown): value is {
  listConnectorAccountCredentialRefs?: (params: {
    accountId: string;
  }) => Promise<CredentialRefRecord[]>;
  getConnectorAccountCredentialRef?: (params: {
    accountId: string;
    credentialType: string;
  }) => Promise<CredentialRefRecord | null>;
} {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as JsonRecord;
  return (
    typeof candidate.listConnectorAccountCredentialRefs === "function" ||
    typeof candidate.getConnectorAccountCredentialRef === "function"
  );
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
