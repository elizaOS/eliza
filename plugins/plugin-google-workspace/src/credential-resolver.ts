/**
 * `DefaultGoogleCredentialResolver` — turns a stored Google connector account
 * into an authenticated OAuth2 client for a given account + capability set. It
 * reads OAuth token material only from connector-account credential refs and
 * resolves those opaque refs through the runtime credential store or vault,
 * merging the stored token shapes into a
 * single `Auth.Credentials`. Resolved clients are cached by a version derived
 * from the account and credential records so token rotation invalidates the
 * cache. The many accepted credential-type spellings exist to interoperate with
 * however the OAuth store or cloud flow labeled the persisted tokens.
 */
import {
  CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE,
  type ConnectorAccount,
  type ConnectorAccountManager,
  type ConnectorAccountStorage,
  getConnectorAccountManager,
  type IAgentRuntime,
  resolveSetting,
} from "@elizaos/core";
import { type Credentials, OAuth2Client } from "google-auth-library";

import {
  CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPES,
  CONNECTOR_VAULT_SERVICE_TYPES,
  CORE_SECRETS_SERVICE_TYPE,
} from "./connector-credential-refs.js";
import type {
  GoogleAuthClient,
  GoogleAuthResolutionRequest,
  GoogleCredentialResolver,
} from "./types.js";
import { GOOGLE_SERVICE_NAME } from "./types.js";

const GOOGLE_CLIENT_ID_SETTING = "GOOGLE_CLIENT_ID";
const GOOGLE_CLIENT_SECRET_SETTING = "GOOGLE_CLIENT_SECRET";
const ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID_SETTING = "ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID";

// Read-side store resolution mirrors the write side exactly
// (connector-credential-refs.ts): same service names, same precedence. A
// name probed by only one side is how a credential gets written to a store
// the reader can never find again after a restart.
const SECRET_READER_SERVICE_TYPES = [
  ...CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPES,
  ...CONNECTOR_VAULT_SERVICE_TYPES,
] as const;

const TOKEN_SET_CREDENTIAL_TYPES = ["oauth.tokens", "oauth.token_set", "oauth"] as const;
const ACCESS_TOKEN_CREDENTIAL_TYPES = [
  "oauth.access_token",
  "oauth.accessToken",
  "access_token",
  "accessToken",
] as const;
const REFRESH_TOKEN_CREDENTIAL_TYPES = [
  "oauth.refresh_token",
  "oauth.refreshToken",
  "refresh_token",
  "refreshToken",
] as const;
const ID_TOKEN_CREDENTIAL_TYPES = [
  "oauth.id_token",
  "oauth.idToken",
  "id_token",
  "idToken",
] as const;
const EXPIRY_CREDENTIAL_TYPES = [
  "oauth.expiry_date",
  "oauth.expiryDate",
  "expiry_date",
  "expiryDate",
  "expires_at",
  "expiresAt",
] as const;

type JsonRecord = Record<string, unknown>;

export interface GoogleCredentialSecretReader {
  get(
    vaultRef: string,
    options?: { reveal?: boolean; caller?: string }
  ): Promise<string | null> | string | null;
  reveal?(vaultRef: string, caller?: string): Promise<string> | string;
}

interface ConnectorCredentialRefRecord {
  credentialType: string;
  vaultRef: string;
  metadata?: JsonRecord | null;
  expiresAt?: number | string | Date | null;
  updatedAt?: number | string | Date | null;
  version?: string | number | null;
}

interface ConnectorCredentialRefStorage {
  getConnectorAccountCredentialRef(params: {
    accountId: string;
    credentialType: string;
  }): Promise<ConnectorCredentialRefRecord | null>;
  listConnectorAccountCredentialRefs?(params: {
    accountId: string;
  }): Promise<ConnectorCredentialRefRecord[]>;
}

type GoogleConnectorStorage = ConnectorAccountStorage & Partial<ConnectorCredentialRefStorage>;

export interface DefaultGoogleCredentialResolverOptions {
  runtime?: IAgentRuntime | null;
  accountManager?: ConnectorAccountManager;
  storage?: ConnectorAccountStorage;
  credentialStore?: GoogleCredentialSecretReader;
  vault?: GoogleCredentialSecretReader;
  clientId?: string;
  redirectUri?: string;
}

interface ResolvedGoogleCredentialMaterial {
  credentials: Credentials;
  version?: string;
}

export class DefaultGoogleCredentialResolver implements GoogleCredentialResolver {
  private readonly runtime?: IAgentRuntime | null;
  private readonly accountManager?: ConnectorAccountManager;
  private readonly storage?: ConnectorAccountStorage;
  private readonly credentialStore?: GoogleCredentialSecretReader;
  private readonly vault?: GoogleCredentialSecretReader;
  private readonly clientId?: string;
  private readonly redirectUri?: string;
  private readonly clientCache = new Map<string, GoogleAuthClient>();

  constructor(options: DefaultGoogleCredentialResolverOptions = {}) {
    this.runtime = options.runtime;
    this.accountManager = options.accountManager;
    this.storage = options.storage;
    this.credentialStore = options.credentialStore;
    this.vault = options.vault;
    this.clientId = nonEmptyString(options.clientId);
    this.redirectUri = nonEmptyString(options.redirectUri);
  }

  async getAuthClient(request: GoogleAuthResolutionRequest): Promise<GoogleAuthClient> {
    if (request.provider !== GOOGLE_SERVICE_NAME) {
      throw new Error(
        `DefaultGoogleCredentialResolver only supports provider "${GOOGLE_SERVICE_NAME}".`
      );
    }

    const account = await this.getAccount(request.accountId);
    if (!account) {
      throw new Error(
        `Google account ${request.accountId} was not found in connector account storage.`
      );
    }
    if (account.status !== "connected") {
      throw new Error(`Google account ${request.accountId} is ${account.status}, not connected.`);
    }

    const clientConfig = await this.resolveOAuthClientConfig();
    const storage = this.resolveStorage();
    const records: ConnectorCredentialRefRecord[] = [
      ...(storage ? await this.loadCredentialRecords(storage, account.id) : []),
      ...(await this.loadRuntimeAdapterCredentialRecords(account.id)),
    ];
    const version = credentialVersion(account, records);
    const cacheKey = version
      ? this.cacheKey(request.accountId, version, request.scopes, clientConfig)
      : undefined;

    if (cacheKey) {
      const cached = this.clientCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const material = await this.resolveCredentialMaterial(account, request, records, version);
    if (material.credentials.refresh_token && !clientConfig.clientId) {
      throw new Error(
        "Google OAuth refresh_token is available, but this elizaOS build has no managed Google OAuth client registration."
      );
    }
    const client = new OAuth2Client(
      clientConfig.clientId,
      clientConfig.clientSecret,
      clientConfig.redirectUri
    );
    client.setCredentials(material.credentials);

    if (cacheKey) {
      if (this.clientCache.size > 100) {
        this.clientCache.clear();
      }
      this.clientCache.set(cacheKey, client);
    }

    return client;
  }

  clearCache(accountId?: string): void {
    if (!accountId) {
      this.clientCache.clear();
      return;
    }
    for (const key of this.clientCache.keys()) {
      if (key.startsWith(`${accountId}:`)) {
        this.clientCache.delete(key);
      }
    }
  }

  private async getAccount(accountId: string): Promise<ConnectorAccount | null> {
    const direct = await this.getAccountById(accountId);
    if (direct) {
      return direct;
    }
    // "default" is the adapter-level placeholder for "the user's Google
    // account" (lifeops-message-adapter DEFAULT_GOOGLE_ACCOUNT_ID). Accounts
    // connected through the OAuth flow are stored under manager-assigned ids,
    // so a literal lookup always misses. Resolve it to the sole connected
    // account; with zero or multiple connected accounts the miss stands and
    // the caller's not-found error names the ambiguity honestly.
    if (accountId === "default") {
      const accounts = await this.listAccounts();
      const connected = accounts.filter((account) => account.status === "connected");
      if (connected.length === 1) {
        return connected[0];
      }
    }
    return null;
  }

  /** List Google accounts from the same source precedence `getAccountById` uses. */
  private async listAccounts(): Promise<ConnectorAccount[]> {
    if (this.storage) {
      return (await this.storage.listAccounts(GOOGLE_SERVICE_NAME)) ?? [];
    }
    const manager = this.accountManager ?? this.getRuntimeAccountManager();
    if (manager) {
      return manager.listAccounts(GOOGLE_SERVICE_NAME);
    }
    return (await this.resolveStorage()?.listAccounts?.(GOOGLE_SERVICE_NAME)) ?? [];
  }

  private async getAccountById(accountId: string): Promise<ConnectorAccount | null> {
    if (this.storage) {
      return this.storage.getAccount(GOOGLE_SERVICE_NAME, accountId);
    }
    const manager = this.accountManager ?? this.getRuntimeAccountManager();
    if (manager) {
      return manager.getAccount(GOOGLE_SERVICE_NAME, accountId);
    }
    const storage = this.resolveStorage();
    return storage?.getAccount(GOOGLE_SERVICE_NAME, accountId) ?? null;
  }

  private getRuntimeAccountManager(): ConnectorAccountManager | null {
    if (!this.runtime) {
      return null;
    }
    return getConnectorAccountManager(this.runtime);
  }

  private resolveStorage(): GoogleConnectorStorage | null {
    if (this.storage) {
      return this.storage as GoogleConnectorStorage;
    }

    if (this.runtime?.getService) {
      const service = safelyGetService(this.runtime, CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE);
      if (isConnectorAccountStorageLike(service)) {
        return service as GoogleConnectorStorage;
      }
    }

    const manager = this.accountManager ?? this.getRuntimeAccountManager();
    return (manager?.getStorage() as GoogleConnectorStorage | undefined) ?? null;
  }

  private async resolveCredentialMaterial(
    _account: ConnectorAccount,
    request: GoogleAuthResolutionRequest,
    records: ConnectorCredentialRefRecord[],
    version: string | undefined
  ): Promise<ResolvedGoogleCredentialMaterial> {
    const credentials: Credentials = {};

    for (const record of records) {
      await this.mergeCredentialRecord(credentials, record);
    }

    if (!credentials.access_token && !credentials.refresh_token) {
      const foundRefs = records
        .filter((record) => record.vaultRef)
        .map((record) => record.credentialType);
      const refText = foundRefs.length
        ? ` Found credential refs for: ${foundRefs.join(", ")}.`
        : "";
      throw new Error(
        `Google OAuth credentials for account ${request.accountId} were not available in the connector OAuth store.` +
          `${refText} Expected oauth.tokens or oauth.access_token/oauth.refresh_token credential refs.`
      );
    }

    if (!credentials.scope && request.scopes.length > 0) {
      credentials.scope = request.scopes.join(" ");
    }

    return {
      credentials,
      version,
    };
  }

  private async loadCredentialRecords(
    storage: GoogleConnectorStorage,
    accountId: string
  ): Promise<ConnectorCredentialRefRecord[]> {
    if (typeof storage.listConnectorAccountCredentialRefs === "function") {
      return storage.listConnectorAccountCredentialRefs({ accountId });
    }

    const records: ConnectorCredentialRefRecord[] = [];
    if (typeof storage.getConnectorAccountCredentialRef === "function") {
      for (const credentialType of [
        ...TOKEN_SET_CREDENTIAL_TYPES,
        ...ACCESS_TOKEN_CREDENTIAL_TYPES,
        ...REFRESH_TOKEN_CREDENTIAL_TYPES,
        ...ID_TOKEN_CREDENTIAL_TYPES,
        ...EXPIRY_CREDENTIAL_TYPES,
      ]) {
        const record = await storage.getConnectorAccountCredentialRef({
          accountId,
          credentialType,
        });
        if (record) {
          records.push(record);
        }
      }
    }

    return records;
  }

  private async loadRuntimeAdapterCredentialRecords(
    accountId: string
  ): Promise<ConnectorCredentialRefRecord[]> {
    const adapter = (this.runtime as { adapter?: unknown } | undefined)?.adapter;
    if (!adapter) return [];
    if (!isConnectorCredentialRefStorageLike(adapter)) return [];
    if (typeof adapter.listConnectorAccountCredentialRefs === "function") {
      return adapter.listConnectorAccountCredentialRefs({ accountId });
    }
    const records: ConnectorCredentialRefRecord[] = [];
    if (typeof adapter.getConnectorAccountCredentialRef === "function") {
      for (const credentialType of [
        ...TOKEN_SET_CREDENTIAL_TYPES,
        ...ACCESS_TOKEN_CREDENTIAL_TYPES,
        ...REFRESH_TOKEN_CREDENTIAL_TYPES,
        ...ID_TOKEN_CREDENTIAL_TYPES,
        ...EXPIRY_CREDENTIAL_TYPES,
      ]) {
        const record = await adapter.getConnectorAccountCredentialRef({
          accountId,
          credentialType,
        });
        if (record) {
          records.push(record);
        }
      }
    }
    return records;
  }

  private async mergeCredentialRecord(
    credentials: Credentials,
    record: ConnectorCredentialRefRecord
  ): Promise<void> {
    const value = await this.readVaultRef(record.vaultRef, record.credentialType);

    if (!value) {
      return;
    }

    mergeCredentialValue(credentials, record.credentialType, value, record);
  }

  private async readVaultRef(
    vaultRef: string,
    credentialType: string
  ): Promise<string | undefined> {
    const readers = this.resolveSecretReaders();
    if (readers.length === 0) {
      throw new Error(
        `Google connector credential ${credentialType} points at ${vaultRef}, but no connector credential store or vault reader is available.`
      );
    }

    const errors: string[] = [];
    for (const reader of readers) {
      try {
        const value = await readSecret(reader, vaultRef, this.runtime);
        const trimmed = nonEmptyString(value);
        if (trimmed) {
          return trimmed;
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    throw new Error(
      `Google connector credential ${credentialType} could not be read from ${vaultRef}.` +
        (errors.length ? ` Last errors: ${errors.slice(-3).join("; ")}` : "")
    );
  }

  private resolveSecretReaders(): unknown[] {
    const readers: unknown[] = [];
    if (this.credentialStore) readers.push(this.credentialStore);
    if (this.vault) readers.push(this.vault);

    if (this.runtime?.getService) {
      for (const serviceType of SECRET_READER_SERVICE_TYPES) {
        const service = safelyGetService(this.runtime, serviceType);
        if (service) readers.push(service);
      }
    }

    return readers;
  }

  private async resolveOAuthClientConfig(): Promise<{
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  }> {
    const managedDesktopClientId = readSetting(
      this.runtime,
      ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID_SETTING
    );
    if (managedDesktopClientId) {
      return {
        clientId: this.clientId ?? managedDesktopClientId,
        redirectUri: this.redirectUri,
      };
    }

    const configuredClientId = readSetting(this.runtime, GOOGLE_CLIENT_ID_SETTING);
    const configuredSecret = readSetting(this.runtime, GOOGLE_CLIENT_SECRET_SETTING);
    if (configuredClientId && configuredSecret) {
      return {
        clientId: this.clientId ?? configuredClientId,
        clientSecret: configuredSecret,
        redirectUri: this.redirectUri,
      };
    }

    const secrets = (
      this.runtime ? safelyGetService(this.runtime, CORE_SECRETS_SERVICE_TYPE) : null
    ) as {
      getGlobal?: (key: string) => Promise<string | null>;
    } | null;
    const clientId = nonEmptyString(await secrets?.getGlobal?.(GOOGLE_CLIENT_ID_SETTING));
    const clientSecret = nonEmptyString(await secrets?.getGlobal?.(GOOGLE_CLIENT_SECRET_SETTING));
    return {
      clientId: this.clientId ?? clientId,
      clientSecret,
      redirectUri: this.redirectUri,
    };
  }

  private cacheKey(
    accountId: string,
    version: string,
    scopes: readonly string[],
    clientConfig: { clientId?: string; redirectUri?: string }
  ): string {
    const scopeKey = [...scopes].sort().join(" ");
    return [
      accountId,
      version,
      clientConfig.clientId ?? "",
      clientConfig.redirectUri ?? "",
      scopeKey,
    ].join(":");
  }
}

function isConnectorAccountStorageLike(value: unknown): value is ConnectorAccountStorage {
  const candidate = value as Partial<ConnectorAccountStorage> | undefined;
  return (
    Boolean(candidate) &&
    typeof candidate?.listAccounts === "function" &&
    typeof candidate?.getAccount === "function" &&
    typeof candidate?.upsertAccount === "function" &&
    typeof candidate?.deleteAccount === "function"
  );
}

function isConnectorCredentialRefStorageLike(
  value: unknown
): value is ConnectorCredentialRefStorage {
  const candidate = value as Partial<ConnectorCredentialRefStorage> | undefined;
  return (
    Boolean(candidate) &&
    (typeof candidate?.listConnectorAccountCredentialRefs === "function" ||
      typeof candidate?.getConnectorAccountCredentialRef === "function")
  );
}

function safelyGetService(runtime: IAgentRuntime, serviceType: string): unknown {
  try {
    return runtime.getService(serviceType);
  } catch {
    return null;
  }
}

function readSetting(runtime: IAgentRuntime | null | undefined, key: string): string | undefined {
  return nonEmptyString(resolveSetting(runtime, key));
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function readStringFromRecord(
  record: JsonRecord | undefined,
  ...keys: string[]
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = nonEmptyString(record[key]);
    if (value) return value;
  }
  return undefined;
}

async function readSecret(
  reader: unknown,
  vaultRef: string,
  runtime?: IAgentRuntime | null
): Promise<string | null> {
  const candidate = reader as {
    reveal?: (key: string, caller?: string) => Promise<string> | string;
    get?: (
      key: string,
      optionsOrContext?: { reveal?: boolean; caller?: string } | JsonRecord
    ) => Promise<string | null> | string | null;
  };

  if (typeof candidate.reveal === "function") {
    return candidate.reveal(vaultRef, "plugin-google-workspace");
  }

  if (typeof candidate.get !== "function") {
    return null;
  }

  if (
    reader &&
    (reader as { constructor?: { name?: string } }).constructor?.name === "SecretsService"
  ) {
    return candidate.get(vaultRef, {
      level: "global",
      agentId: runtime?.agentId,
      requesterId: runtime?.agentId,
    });
  }

  return candidate.get(vaultRef, { reveal: true, caller: "plugin-google-workspace" });
}

function mergeCredentialValue(
  credentials: Credentials,
  credentialType: string,
  rawValue: string,
  record?: ConnectorCredentialRefRecord
): void {
  const parsed = parseMaybeJson(rawValue);
  if (isCredentialType(credentialType, TOKEN_SET_CREDENTIAL_TYPES)) {
    mergeCredentialObject(credentials, parsed ?? rawValue);
    applyRecordExpiry(credentials, record);
    return;
  }

  if (isCredentialType(credentialType, ACCESS_TOKEN_CREDENTIAL_TYPES)) {
    credentials.access_token = rawValue;
  } else if (isCredentialType(credentialType, REFRESH_TOKEN_CREDENTIAL_TYPES)) {
    credentials.refresh_token = rawValue;
  } else if (isCredentialType(credentialType, ID_TOKEN_CREDENTIAL_TYPES)) {
    credentials.id_token = rawValue;
  } else if (isCredentialType(credentialType, EXPIRY_CREDENTIAL_TYPES)) {
    credentials.expiry_date = parseExpiry(rawValue);
  } else if (parsed) {
    mergeCredentialObject(credentials, parsed);
  }

  applyRecordExpiry(credentials, record);
}

function mergeCredentialObject(credentials: Credentials, value: unknown): void {
  const record = asRecord(value);
  if (!record) return;

  const nested = asRecord(record.tokens) ?? asRecord(record.oauthTokens);
  if (nested) {
    mergeCredentialObject(credentials, nested);
  }

  const accessToken = readStringFromRecord(record, "access_token", "accessToken");
  const refreshToken = readStringFromRecord(record, "refresh_token", "refreshToken");
  const idToken = readStringFromRecord(record, "id_token", "idToken");
  const tokenType = readStringFromRecord(record, "token_type", "tokenType");
  const scope = readStringFromRecord(record, "scope");
  const expiry = record.expiry_date ?? record.expiryDate ?? record.expires_at ?? record.expiresAt;

  if (accessToken) credentials.access_token = accessToken;
  if (refreshToken) credentials.refresh_token = refreshToken;
  if (idToken) credentials.id_token = idToken;
  if (tokenType) credentials.token_type = tokenType;
  if (Array.isArray(record.scopes)) {
    credentials.scope = record.scopes
      .filter((item): item is string => typeof item === "string")
      .join(" ");
  } else if (scope) {
    credentials.scope = scope;
  }

  const expiryDate = parseExpiry(expiry);
  if (expiryDate) credentials.expiry_date = expiryDate;
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

function isCredentialType(credentialType: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => candidate.toLowerCase() === credentialType.toLowerCase());
}

function parseExpiry(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return parseExpiry(numeric);
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function applyRecordExpiry(
  credentials: Credentials,
  record: ConnectorCredentialRefRecord | undefined
): void {
  if (credentials.expiry_date || !record?.expiresAt) return;
  credentials.expiry_date = parseExpiry(record.expiresAt);
}

function credentialVersionFromRecord(record: ConnectorCredentialRefRecord): string | undefined {
  const metadata = asRecord(record.metadata);
  return (
    stringVersion(record.version) ??
    stringVersion(metadata?.version) ??
    stringVersion(metadata?.credentialVersion) ??
    dateVersion(record.updatedAt)
  );
}

function credentialVersion(
  account: ConnectorAccount,
  records: readonly ConnectorCredentialRefRecord[]
): string | undefined {
  const versionParts = [...credentialVersionsFromAccount(account)];
  for (const record of records) {
    const version = credentialVersionFromRecord(record);
    if (version) {
      versionParts.push(`${record.credentialType}:${version}`);
    }
  }
  return versionParts.length ? versionParts.sort().join("|") : undefined;
}

function credentialVersionsFromAccount(account: ConnectorAccount): string[] {
  const metadata = asRecord(account.metadata);
  const oauth = asRecord(metadata?.oauth);
  return [
    stringVersion(metadata?.credentialVersion),
    stringVersion(metadata?.oauthCredentialVersion),
    stringVersion(metadata?.googleCredentialVersion),
    stringVersion(oauth?.credentialVersion),
  ].filter((value): value is string => Boolean(value));
}

function dateVersion(value: unknown): string | undefined {
  const parsed = parseExpiry(value);
  return parsed ? String(parsed) : undefined;
}

function stringVersion(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return nonEmptyString(value);
}
