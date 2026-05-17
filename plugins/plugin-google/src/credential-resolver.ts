import {
  CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE,
  type ConnectorAccount,
  type ConnectorAccountManager,
  type ConnectorAccountStorage,
  getConnectorAccountManager,
  type IAgentRuntime,
} from "@elizaos/core";
import { type Credentials, OAuth2Client } from "google-auth-library";
import { credentialRefRecordsFromMetadata } from "./connector-credential-refs.js";
import type {
  GoogleAuthClient,
  GoogleAuthResolutionRequest,
  GoogleCredentialResolver,
} from "./types.js";
import { GOOGLE_SERVICE_NAME } from "./types.js";

const GOOGLE_CLIENT_ID_SETTING = "GOOGLE_CLIENT_ID";
const GOOGLE_CLIENT_SECRET_SETTING = "GOOGLE_CLIENT_SECRET";
const GOOGLE_REDIRECT_URI_SETTING = "GOOGLE_REDIRECT_URI";
const CORE_SECRETS_SERVICE_TYPE = "SECRETS";

const CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPES = [
  "connector_credential_store",
  "CONNECTOR_CREDENTIAL_STORE",
  "connectorCredentialStore",
  "credential_store",
  "vault",
  "secrets_manager",
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
  vaultRef?: string | null;
  value?: string | null;
  token?: string | null;
  secret?: string | null;
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

interface ConnectorCredentialValueStorage {
  getConnectorAccountCredential?(params: {
    provider: string;
    accountId: string;
    credentialType: string;
  }): Promise<ConnectorCredentialRefRecord | string | null>;
}

type GoogleConnectorStorage = ConnectorAccountStorage &
  Partial<ConnectorCredentialRefStorage> &
  ConnectorCredentialValueStorage;

export interface DefaultGoogleCredentialResolverOptions {
  runtime?: IAgentRuntime | null;
  accountManager?: ConnectorAccountManager;
  storage?: ConnectorAccountStorage;
  credentialStore?: GoogleCredentialSecretReader;
  vault?: GoogleCredentialSecretReader;
  clientId?: string;
  clientSecret?: string;
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
  private readonly clientSecret?: string;
  private readonly redirectUri?: string;
  private readonly clientCache = new Map<string, GoogleAuthClient>();

  constructor(options: DefaultGoogleCredentialResolverOptions = {}) {
    this.runtime = options.runtime;
    this.accountManager = options.accountManager;
    this.storage = options.storage;
    this.credentialStore = options.credentialStore;
    this.vault = options.vault;
    this.clientId = nonEmptyString(options.clientId);
    this.clientSecret = nonEmptyString(options.clientSecret);
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

    const clientConfig = this.resolveOAuthClientConfig(account);
    const storage = this.resolveStorage();
    const metadataRecords = credentialRefRecordsFromMetadata(
      account.metadata
    ) as ConnectorCredentialRefRecord[];
    const records: ConnectorCredentialRefRecord[] = [
      ...metadataRecords,
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
    if (
      material.credentials.refresh_token &&
      (!clientConfig.clientId || !clientConfig.clientSecret)
    ) {
      throw new Error(
        "Google OAuth refresh_token is available, but GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not configured for token refresh."
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

    if (typeof storage.getConnectorAccountCredential === "function") {
      for (const credentialType of [
        ...TOKEN_SET_CREDENTIAL_TYPES,
        ...ACCESS_TOKEN_CREDENTIAL_TYPES,
        ...REFRESH_TOKEN_CREDENTIAL_TYPES,
      ]) {
        const resolved = await storage.getConnectorAccountCredential({
          provider: GOOGLE_SERVICE_NAME,
          accountId,
          credentialType,
        });
        if (typeof resolved === "string") {
          records.push({ credentialType, value: resolved });
        } else if (resolved) {
          records.push(resolved);
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
    const value =
      nonEmptyString(record.value) ??
      nonEmptyString(record.token) ??
      nonEmptyString(record.secret) ??
      (record.vaultRef
        ? await this.readVaultRef(record.vaultRef, record.credentialType)
        : undefined);

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
      for (const serviceType of CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPES) {
        const service = safelyGetService(this.runtime, serviceType);
        if (service) readers.push(service);
      }
      const secretsService = safelyGetService(this.runtime, CORE_SECRETS_SERVICE_TYPE) as {
        get?: (key: string, context: JsonRecord) => Promise<string | null> | string | null;
      } | null;
      if (typeof secretsService?.get === "function") {
        readers.push({
          get: (key: string) =>
            secretsService.get?.(key, {
              level: "global",
              agentId: this.runtime?.agentId,
            }) ?? null,
        });
      }
    }

    return readers;
  }

  private resolveOAuthClientConfig(account: ConnectorAccount): {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  } {
    const metadata = asRecord(account.metadata);
    const oauth = asRecord(metadata?.oauth);
    const client = asRecord(metadata?.oauthClient) ?? asRecord(metadata?.client);

    return {
      clientId:
        this.clientId ??
        readStringFromRecord(client, "clientId", "client_id") ??
        readStringFromRecord(oauth, "clientId", "client_id") ??
        readSetting(this.runtime, GOOGLE_CLIENT_ID_SETTING),
      clientSecret:
        this.clientSecret ??
        readStringFromRecord(client, "clientSecret", "client_secret") ??
        readStringFromRecord(oauth, "clientSecret", "client_secret") ??
        readSetting(this.runtime, GOOGLE_CLIENT_SECRET_SETTING),
      redirectUri:
        this.redirectUri ??
        readStringFromRecord(client, "redirectUri", "redirect_uri") ??
        readStringFromRecord(oauth, "redirectUri", "redirect_uri") ??
        readSetting(this.runtime, GOOGLE_REDIRECT_URI_SETTING),
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
  const value = runtime?.getSetting?.(key);
  return nonEmptyString(value);
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
    return candidate.reveal(vaultRef, "plugin-google");
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
    });
  }

  return candidate.get(vaultRef, { reveal: true, caller: "plugin-google" });
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
