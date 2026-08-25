/**
 * Resolves delegated Microsoft calendar accounts and OAuth credentials without
 * placing token material in calendar records. ConnectorAccountManager owns
 * account identity; durable credential refs point at the runtime secret store.
 */
import { createHash } from "node:crypto";
import {
  type ConnectorAccount,
  ElizaError,
  getConnectorAccountManager,
  type IAgentRuntime,
  SECRETS_SERVICE_TYPE,
} from "@elizaos/core";
import type {
  LifeOpsConnectorGrant,
  LifeOpsConnectorSide,
  LifeOpsMicrosoftCapability,
} from "@elizaos/shared";

export const MICROSOFT_CALENDAR_PROVIDER = "microsoft";
export const MICROSOFT_CALENDAR_GRANT_PREFIX = "connector-account:microsoft:";

const MICROSOFT_TOKEN_ENDPOINT_ROOT = "https://login.microsoftonline.com";
const MICROSOFT_CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const ACCESS_TOKEN_TYPES = [
  "oauth.access_token",
  "oauth.accessToken",
  "access_token",
  "accessToken",
] as const;
const REFRESH_TOKEN_TYPES = [
  "oauth.refresh_token",
  "oauth.refreshToken",
  "refresh_token",
  "refreshToken",
] as const;
const TOKEN_SET_TYPES = ["oauth.tokens", "oauth.token_set", "oauth"] as const;
const SECRET_SERVICE_TYPES = [
  "connector_credential_store",
  "CONNECTOR_CREDENTIAL_STORE",
  "connectorCredentialStore",
  "credential_store",
  "vault",
  "VAULT",
  SECRETS_SERVICE_TYPE,
] as const;
// Write candidates exclude the in-memory core SECRETS service: tokens written
// there die with the process while the persisted vaultRef dangles (#18080).
// SECRETS stays a read-side probe above for refs written by older builds.
const SECRET_WRITER_SERVICE_TYPES = SECRET_SERVICE_TYPES.filter(
  (type) => type !== SECRETS_SERVICE_TYPE,
);

type JsonRecord = Record<string, unknown>;

export interface MicrosoftCalendarAccount {
  account: ConnectorAccount;
  grant: LifeOpsConnectorGrant;
  accountKind: "organization" | "personal" | "unknown";
}

export interface MicrosoftCalendarAccessToken {
  value: string;
  expiresAt: number | null;
}

export interface MicrosoftCalendarTokenResolver {
  resolve(account: ConnectorAccount): Promise<MicrosoftCalendarAccessToken>;
}

interface CredentialRefRecord {
  credentialType: string;
  vaultRef: string;
  expiresAt: number | string | Date | null;
  updatedAt: number | string | Date | null;
}

interface CredentialRefAdapter {
  listConnectorAccountCredentialRefs?(params: {
    accountId: string;
  }): Promise<unknown[]>;
  getConnectorAccountCredentialRef?(params: {
    accountId: string;
    credentialType: string;
  }): Promise<unknown | null>;
  setConnectorAccountCredentialRef?(params: {
    accountId: string;
    credentialType: string;
    vaultRef: string;
    metadata?: Record<string, never>;
    expiresAt?: number | null;
    lastVerifiedAt?: number | null;
  }): Promise<unknown>;
}

interface TokenMaterial {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  accessRef: CredentialRefRecord | null;
  refreshRef: CredentialRefRecord | null;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => stringValue(item))
        .filter((item): item is string => item !== null)
    : [];
}

function metadata(account: ConnectorAccount): JsonRecord {
  return record(account.metadata) ?? {};
}

function sideForAccount(account: ConnectorAccount): LifeOpsConnectorSide {
  return account.role === "AGENT" ? "agent" : "owner";
}

function isoFromEpoch(value: number, connectorAccountId: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ElizaError("Microsoft connector account timestamp is invalid.", {
      code: "MICROSOFT_ACCOUNT_TIMESTAMP_INVALID",
      context: { connectorAccountId },
      severity: "fatal",
    });
  }
  return parsed.toISOString();
}

function grantedScopes(account: ConnectorAccount): string[] {
  const meta = metadata(account);
  const oauth = record(meta.oauth);
  return [
    ...new Set([
      ...stringValues(meta.grantedScopes),
      ...stringValues(meta.scopes),
      ...stringValues(oauth?.grantedScopes),
      ...stringValues(oauth?.scopes),
    ]),
  ];
}

function normalizedScopeName(scope: string): string {
  const lastPathSegment = scope.split("/").at(-1) ?? scope;
  return lastPathSegment.trim().toLowerCase();
}

/**
 * Maps granted Microsoft Graph scopes onto the normalized capability catalog
 * shared across the calendar, mail, contacts, and files domains. Consumed by
 * grant derivation and exported so domain plugins and tests can reason about
 * an account's effective capabilities without reparsing scope strings.
 */
export function capabilitiesForScopes(
  scopes: readonly string[],
): LifeOpsMicrosoftCapability[] {
  const normalized = new Set(scopes.map(normalizedScopeName));
  const capabilities = new Set<LifeOpsMicrosoftCapability>();
  if (
    normalized.has("openid") ||
    normalized.has("profile") ||
    normalized.has("email") ||
    normalized.has("user.read")
  ) {
    capabilities.add("microsoft.basic_identity");
  }
  const hasReadBasic =
    normalized.has("calendars.readbasic") ||
    normalized.has("calendars.read") ||
    normalized.has("calendars.read.shared") ||
    normalized.has("calendars.readwrite") ||
    normalized.has("calendars.readwrite.shared");
  const hasRead =
    normalized.has("calendars.read") ||
    normalized.has("calendars.read.shared") ||
    normalized.has("calendars.readwrite") ||
    normalized.has("calendars.readwrite.shared");
  const hasWrite =
    normalized.has("calendars.readwrite") ||
    normalized.has("calendars.readwrite.shared");
  if (hasReadBasic) {
    capabilities.add("microsoft.calendar.read_basic");
    capabilities.add("microsoft.calendar.freebusy");
  }
  if (hasRead) capabilities.add("microsoft.calendar.read");
  if (hasWrite) capabilities.add("microsoft.calendar.write");
  const hasMailManage =
    normalized.has("mail.readwrite") || normalized.has("mail.readwrite.shared");
  if (
    hasMailManage ||
    normalized.has("mail.read") ||
    normalized.has("mail.read.shared")
  ) {
    capabilities.add("microsoft.mail.triage");
  }
  if (hasMailManage) capabilities.add("microsoft.mail.manage");
  if (normalized.has("mail.send") || normalized.has("mail.send.shared")) {
    capabilities.add("microsoft.mail.send");
  }
  if (
    normalized.has("contacts.read") ||
    normalized.has("contacts.read.shared") ||
    normalized.has("contacts.readwrite") ||
    normalized.has("contacts.readwrite.shared")
  ) {
    capabilities.add("microsoft.contacts.read");
  }
  if (
    normalized.has("files.read") ||
    normalized.has("files.read.all") ||
    normalized.has("files.readwrite") ||
    normalized.has("files.readwrite.all")
  ) {
    capabilities.add("microsoft.files.read");
  }
  return [...capabilities];
}

function hasPlaintextCredentialMetadata(account: ConnectorAccount): boolean {
  const meta = metadata(account);
  const oauth = record(meta.oauth);
  const forbiddenKeys = [
    "accessToken",
    "access_token",
    "refreshToken",
    "refresh_token",
    "idToken",
    "id_token",
    "tokens",
  ];
  return forbiddenKeys.some(
    (key) => meta[key] !== undefined || oauth?.[key] !== undefined,
  );
}

function accountKind(
  account: ConnectorAccount,
): MicrosoftCalendarAccount["accountKind"] {
  const meta = metadata(account);
  const explicit = stringValue(
    meta.accountKind ?? meta.accountType ?? meta.tenantType,
  )?.toLowerCase();
  if (
    explicit === "personal" ||
    explicit === "consumer" ||
    explicit === "msa"
  ) {
    return "personal";
  }
  if (
    explicit === "organization" ||
    explicit === "organizational" ||
    explicit === "work" ||
    explicit === "school" ||
    explicit === "aad"
  ) {
    return "organization";
  }
  const tenant = stringValue(meta.tenantId ?? record(meta.identity)?.tenantId);
  if (
    tenant?.toLowerCase() === "consumers" ||
    tenant?.toLowerCase() === MICROSOFT_CONSUMER_TENANT_ID
  ) {
    return "personal";
  }
  return tenant ? "organization" : "unknown";
}

function grantForAccount(
  runtime: IAgentRuntime,
  account: ConnectorAccount,
): LifeOpsConnectorGrant {
  if (hasPlaintextCredentialMetadata(account)) {
    throw new ElizaError(
      "Microsoft connector credentials must be stored as secret references.",
      {
        code: "MICROSOFT_PLAINTEXT_CREDENTIAL_REJECTED",
        context: { connectorAccountId: account.id },
        severity: "fatal",
      },
    );
  }
  const scopes = grantedScopes(account);
  const capabilities = capabilitiesForScopes(scopes);
  const meta = metadata(account);
  const email =
    stringValue(meta.email) ??
    stringValue(record(meta.identity)?.email) ??
    stringValue(account.displayHandle);
  return {
    id: `${MICROSOFT_CALENDAR_GRANT_PREFIX}${account.id}`,
    agentId: runtime.agentId,
    provider: MICROSOFT_CALENDAR_PROVIDER,
    connectorAccountId: account.id,
    side: sideForAccount(account),
    identity: {
      ...(stringValue(account.externalId)
        ? { sub: stringValue(account.externalId) }
        : {}),
      ...(email ? { email: email.toLowerCase() } : {}),
      ...(stringValue(meta.tenantId)
        ? { tenantId: stringValue(meta.tenantId) }
        : {}),
    },
    identityEmail: email?.toLowerCase() ?? null,
    grantedScopes: scopes,
    capabilities,
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    preferredByAgent: meta.isDefault === true,
    cloudConnectionId: stringValue(meta.cloudConnectionId),
    metadata: {
      connectorAccountId: account.id,
      connectorAccountProvider: MICROSOFT_CALENDAR_PROVIDER,
      accountKind: accountKind(account),
    },
    lastRefreshAt: isoFromEpoch(account.updatedAt, account.id),
    createdAt: isoFromEpoch(account.createdAt, account.id),
    updatedAt: isoFromEpoch(account.updatedAt, account.id),
  };
}

export function microsoftAccountIdFromGrantId(
  grantId: string | null | undefined,
): string | null {
  const normalized = stringValue(grantId);
  if (!normalized) return null;
  return normalized.startsWith(MICROSOFT_CALENDAR_GRANT_PREFIX)
    ? normalized.slice(MICROSOFT_CALENDAR_GRANT_PREFIX.length)
    : null;
}

export function isMicrosoftCalendarGrantId(
  grantId: string | null | undefined,
): boolean {
  return microsoftAccountIdFromGrantId(grantId) !== null;
}

export async function listMicrosoftCalendarAccounts(args: {
  runtime: IAgentRuntime;
  side?: LifeOpsConnectorSide;
  grantId?: string | null;
}): Promise<MicrosoftCalendarAccount[]> {
  const requestedAccountId = microsoftAccountIdFromGrantId(args.grantId);
  const manager = getConnectorAccountManager(args.runtime);
  const accounts = await manager.listAccounts(MICROSOFT_CALENDAR_PROVIDER);
  return accounts
    .filter((account) => account.status === "connected")
    .filter((account) =>
      args.side ? sideForAccount(account) === args.side : true,
    )
    .filter((account) =>
      requestedAccountId ? account.id === requestedAccountId : true,
    )
    .map((account) => ({
      account,
      grant: grantForAccount(args.runtime, account),
      accountKind: accountKind(account),
    }))
    .sort(
      (left, right) =>
        Number(right.grant.preferredByAgent) -
          Number(left.grant.preferredByAgent) ||
        left.account.id.localeCompare(right.account.id),
    );
}

function credentialTimestamp(value: unknown): number | string | Date | null {
  if (
    typeof value === "number" ||
    typeof value === "string" ||
    value instanceof Date
  ) {
    return value;
  }
  return null;
}

function credentialRef(value: unknown): CredentialRefRecord | null {
  const item = record(value);
  const credentialType = stringValue(item?.credentialType ?? item?.type);
  const vaultRef = stringValue(item?.vaultRef ?? item?.ref);
  if (!credentialType || !vaultRef) return null;
  return {
    credentialType,
    vaultRef,
    expiresAt: credentialTimestamp(item?.expiresAt),
    updatedAt: credentialTimestamp(item?.updatedAt),
  };
}

function metadataCredentialRefs(
  account: ConnectorAccount,
): CredentialRefRecord[] {
  const meta = metadata(account);
  const oauth = record(meta.oauth);
  const values = [
    meta.credentialRefs,
    meta.oauthCredentialRefs,
    oauth?.credentialRefs,
  ];
  const refs: CredentialRefRecord[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const parsed = credentialRef(item);
        if (parsed) refs.push(parsed);
      }
      continue;
    }
    const byType = record(value);
    if (!byType) continue;
    for (const [credentialType, refValue] of Object.entries(byType)) {
      const refRecord = record(refValue);
      const parsed = credentialRef({
        credentialType,
        ...(refRecord ?? { vaultRef: refValue }),
      });
      if (parsed) refs.push(parsed);
    }
  }
  return refs;
}

function expiryMs(
  value: CredentialRefRecord["expiresAt"] | unknown,
): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 10_000_000_000 ? value * 1_000 : value;
  }
  const normalized = stringValue(value);
  if (!normalized) return null;
  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) return expiryMs(numeric);
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isCredentialType(value: string, choices: readonly string[]): boolean {
  const normalized = value.toLowerCase();
  return choices.some((choice) => choice.toLowerCase() === normalized);
}

function parseTokenSet(
  raw: string,
  credentialType: string,
): {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    // error-policy:J3 A malformed secret is an explicit invalid-credential
    // result, never a missing-token fallback.
    throw new ElizaError("Microsoft OAuth token set is invalid.", {
      code: "MICROSOFT_TOKEN_SET_INVALID",
      cause,
      context: { credentialType },
      severity: "fatal",
    });
  }
  const token = record(parsed);
  if (!token) {
    throw new ElizaError("Microsoft OAuth token set is invalid.", {
      code: "MICROSOFT_TOKEN_SET_INVALID",
      context: { credentialType },
      severity: "fatal",
    });
  }
  return {
    accessToken: stringValue(token.access_token ?? token.accessToken),
    refreshToken: stringValue(token.refresh_token ?? token.refreshToken),
    expiresAt: expiryMs(
      token.expires_at ??
        token.expiresAt ??
        token.expiry_date ??
        token.expiryDate,
    ),
  };
}

/**
 * Narrow the runtime's database adapter to the credential-ref surface.
 *
 * Every method is optional because adapters vary by deployment, so the shape is
 * verified method-by-method rather than asserted: an adapter that exposes only
 * some of them yields an object carrying exactly those, and callers keep their
 * existing per-method guards.
 */
function adapterForRuntime(
  runtime: IAgentRuntime,
): CredentialRefAdapter | null {
  const candidate = record((runtime as { adapter?: unknown }).adapter);
  if (!candidate) return null;
  const listRefs = candidate.listConnectorAccountCredentialRefs;
  const getRef = candidate.getConnectorAccountCredentialRef;
  const setRef = candidate.setConnectorAccountCredentialRef;
  return {
    ...(typeof listRefs === "function"
      ? {
          listConnectorAccountCredentialRefs: listRefs.bind(
            candidate,
          ) as NonNullable<
            CredentialRefAdapter["listConnectorAccountCredentialRefs"]
          >,
        }
      : {}),
    ...(typeof getRef === "function"
      ? {
          getConnectorAccountCredentialRef: getRef.bind(
            candidate,
          ) as NonNullable<
            CredentialRefAdapter["getConnectorAccountCredentialRef"]
          >,
        }
      : {}),
    ...(typeof setRef === "function"
      ? {
          setConnectorAccountCredentialRef: setRef.bind(
            candidate,
          ) as NonNullable<
            CredentialRefAdapter["setConnectorAccountCredentialRef"]
          >,
        }
      : {}),
  };
}

async function loadCredentialRefs(
  runtime: IAgentRuntime,
  account: ConnectorAccount,
): Promise<CredentialRefRecord[]> {
  const adapter = adapterForRuntime(runtime);
  const refs = [...metadataCredentialRefs(account)];
  if (adapter?.listConnectorAccountCredentialRefs) {
    const stored = await adapter.listConnectorAccountCredentialRefs({
      accountId: account.id,
    });
    refs.push(
      ...stored
        .map(credentialRef)
        .filter((item): item is CredentialRefRecord => item !== null),
    );
  } else if (adapter?.getConnectorAccountCredentialRef) {
    for (const credentialType of [
      ...TOKEN_SET_TYPES,
      ...ACCESS_TOKEN_TYPES,
      ...REFRESH_TOKEN_TYPES,
    ]) {
      const stored = await adapter.getConnectorAccountCredentialRef({
        accountId: account.id,
        credentialType,
      });
      const parsed = credentialRef(stored);
      if (parsed) refs.push(parsed);
    }
  }
  const deduped = new Map<string, CredentialRefRecord>();
  for (const ref of refs) {
    deduped.set(`${ref.credentialType.toLowerCase()}:${ref.vaultRef}`, ref);
  }
  return [...deduped.values()];
}

function runtimeService(runtime: IAgentRuntime, type: string): unknown {
  return runtime.getService(type);
}

async function readSecretValue(
  runtime: IAgentRuntime,
  vaultRef: string,
): Promise<string> {
  let readableStoreFound = false;
  for (const serviceType of SECRET_SERVICE_TYPES) {
    const service = runtimeService(runtime, serviceType) as {
      reveal?: (key: string, caller?: string) => Promise<string> | string;
      getSecret?: (key: string) => Promise<string | null> | string | null;
      get?: (
        key: string,
        context?: Record<string, unknown>,
      ) => Promise<string | null> | string | null;
      getGlobal?: (key: string) => Promise<string | null> | string | null;
    } | null;
    if (!service) continue;
    if (typeof service.reveal === "function") {
      readableStoreFound = true;
      const value = stringValue(
        await service.reveal(vaultRef, "plugin-calendar"),
      );
      if (value) return value;
    }
    if (typeof service.getSecret === "function") {
      readableStoreFound = true;
      const value = stringValue(await service.getSecret(vaultRef));
      if (value) return value;
    }
    if (typeof service.getGlobal === "function") {
      readableStoreFound = true;
      const value = stringValue(await service.getGlobal(vaultRef));
      if (value) return value;
    }
    if (typeof service.get === "function") {
      readableStoreFound = true;
      const value = stringValue(
        await service.get(vaultRef, {
          level: "global",
          agentId: runtime.agentId,
          requesterId: runtime.agentId,
          reveal: true,
          caller: "plugin-calendar",
        }),
      );
      if (value) return value;
    }
  }
  throw new ElizaError(
    readableStoreFound
      ? "Microsoft OAuth credential reference could not be resolved."
      : "Microsoft OAuth credentials require a registered secret reader.",
    {
      code: readableStoreFound
        ? "MICROSOFT_CREDENTIAL_REF_UNRESOLVED"
        : "MICROSOFT_SECRET_READER_UNAVAILABLE",
      context: { credentialRefFingerprint: fingerprint(vaultRef) },
      severity: "fatal",
    },
  );
}

async function writeSecretValue(
  runtime: IAgentRuntime,
  vaultRef: string,
  value: string,
  accountId: string,
  credentialType: string,
): Promise<void> {
  for (const serviceType of SECRET_WRITER_SERVICE_TYPES) {
    const service = runtimeService(runtime, serviceType) as {
      putSecret?: (params: {
        vaultRef: string;
        agentId: string;
        provider: string;
        accountId: string;
        credentialType: string;
        value: string;
        caller: string;
      }) => Promise<string> | string;
      set?: (
        key: string,
        value: string,
        options?: Record<string, unknown>,
      ) => Promise<void> | void;
    } | null;
    if (!service) continue;
    if (typeof service.putSecret === "function") {
      await service.putSecret({
        vaultRef,
        agentId: runtime.agentId,
        provider: MICROSOFT_CALENDAR_PROVIDER,
        accountId,
        credentialType,
        value,
        caller: "plugin-calendar",
      });
      return;
    }
    if (typeof service.set === "function") {
      await service.set(vaultRef, value, {
        sensitive: true,
        caller: "plugin-calendar",
      });
      return;
    }
  }
  throw new ElizaError(
    "Microsoft OAuth token rotation requires a registered secret writer.",
    {
      code: "MICROSOFT_SECRET_WRITER_UNAVAILABLE",
      context: { connectorAccountId: accountId },
      severity: "fatal",
    },
  );
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function tenantForAccount(account: ConnectorAccount): string {
  const meta = metadata(account);
  const tenant =
    stringValue(meta.tenantId ?? record(meta.identity)?.tenantId) ?? "common";
  if (
    !/^(?:common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(
      tenant,
    )
  ) {
    throw new ElizaError("Microsoft connector tenant id is invalid.", {
      code: "MICROSOFT_TENANT_ID_INVALID",
      context: { connectorAccountId: account.id },
      severity: "fatal",
    });
  }
  return tenant.toLowerCase();
}

async function readTokenMaterial(
  runtime: IAgentRuntime,
  refs: readonly CredentialRefRecord[],
): Promise<TokenMaterial> {
  const material: TokenMaterial = {
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    accessRef: null,
    refreshRef: null,
  };
  for (const ref of refs) {
    if (isCredentialType(ref.credentialType, TOKEN_SET_TYPES)) {
      const raw = await readSecretValue(runtime, ref.vaultRef);
      const tokenSet = parseTokenSet(raw, ref.credentialType);
      material.accessToken = tokenSet.accessToken ?? material.accessToken;
      material.refreshToken = tokenSet.refreshToken ?? material.refreshToken;
      material.expiresAt =
        tokenSet.expiresAt ?? expiryMs(ref.expiresAt) ?? material.expiresAt;
      continue;
    }
    if (isCredentialType(ref.credentialType, ACCESS_TOKEN_TYPES)) {
      const raw = await readSecretValue(runtime, ref.vaultRef);
      material.accessToken = raw;
      material.expiresAt = expiryMs(ref.expiresAt);
      material.accessRef = ref;
    }
    if (isCredentialType(ref.credentialType, REFRESH_TOKEN_TYPES)) {
      const raw = await readSecretValue(runtime, ref.vaultRef);
      material.refreshToken = raw;
      material.refreshRef = ref;
    }
  }
  return material;
}

interface MicrosoftRefreshResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

function tokenFetch(runtime: IAgentRuntime): typeof fetch {
  const runtimeFetch = (runtime as { fetch?: typeof fetch }).fetch;
  return runtimeFetch ? runtimeFetch.bind(runtime) : globalThis.fetch;
}

async function refreshMicrosoftToken(args: {
  runtime: IAgentRuntime;
  account: ConnectorAccount;
  refreshToken: string;
  scopes: readonly string[];
}): Promise<MicrosoftRefreshResponse> {
  const clientId = stringValue(args.runtime.getSetting("MICROSOFT_CLIENT_ID"));
  if (!clientId) {
    throw new ElizaError(
      "Microsoft OAuth token refresh requires MICROSOFT_CLIENT_ID.",
      {
        code: "MICROSOFT_OAUTH_CLIENT_ID_MISSING",
        context: { connectorAccountId: args.account.id },
        severity: "fatal",
      },
    );
  }
  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
  });
  const clientSecret = stringValue(
    args.runtime.getSetting("MICROSOFT_CLIENT_SECRET"),
  );
  if (clientSecret) params.set("client_secret", clientSecret);
  if (args.scopes.length > 0) params.set("scope", args.scopes.join(" "));
  const response = await tokenFetch(args.runtime)(
    `${MICROSOFT_TOKEN_ENDPOINT_ROOT}/${tenantForAccount(args.account)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    },
  );
  if (!response.ok) {
    throw new ElizaError("Microsoft OAuth token refresh failed.", {
      code:
        response.status === 400 || response.status === 401
          ? "MICROSOFT_OAUTH_REAUTH_REQUIRED"
          : "MICROSOFT_OAUTH_REFRESH_FAILED",
      context: {
        connectorAccountId: args.account.id,
        status: response.status,
      },
      severity:
        response.status === 429 || response.status >= 500
          ? "ephemeral"
          : "fatal",
    });
  }
  let parsedPayload: unknown;
  try {
    parsedPayload = await response.json();
  } catch (cause) {
    // error-policy:J3 A malformed OAuth response is an explicit invalid token
    // exchange, never an empty or expired credential.
    throw new ElizaError(
      "Microsoft OAuth token refresh returned invalid JSON.",
      {
        code: "MICROSOFT_OAUTH_REFRESH_INVALID",
        cause,
        context: { connectorAccountId: args.account.id },
        severity: "fatal",
      },
    );
  }
  const payload = record(parsedPayload);
  const accessToken = stringValue(payload?.access_token);
  const expiresIn = Number(payload?.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new ElizaError(
      "Microsoft OAuth token refresh returned an invalid payload.",
      {
        code: "MICROSOFT_OAUTH_REFRESH_INVALID",
        context: { connectorAccountId: args.account.id },
        severity: "fatal",
      },
    );
  }
  return {
    accessToken,
    refreshToken: stringValue(payload?.refresh_token),
    expiresAt: Date.now() + expiresIn * 1_000,
  };
}

async function persistRotatedCredential(args: {
  runtime: IAgentRuntime;
  account: ConnectorAccount;
  existingRef: CredentialRefRecord | null;
  credentialType: string;
  value: string;
  expiresAt: number | null;
}): Promise<void> {
  const adapter = adapterForRuntime(args.runtime);
  if (typeof adapter?.setConnectorAccountCredentialRef !== "function") {
    throw new ElizaError(
      "Microsoft OAuth token rotation requires durable credential-ref storage.",
      {
        code: "MICROSOFT_CREDENTIAL_REF_WRITER_UNAVAILABLE",
        context: { connectorAccountId: args.account.id },
        severity: "fatal",
      },
    );
  }
  const vaultRef =
    args.existingRef?.vaultRef ??
    [
      "connector",
      MICROSOFT_CALENDAR_PROVIDER,
      fingerprint(args.runtime.agentId),
      fingerprint(args.account.id),
      args.credentialType.replaceAll(".", "_"),
    ].join("/");
  await writeSecretValue(
    args.runtime,
    vaultRef,
    args.value,
    args.account.id,
    args.credentialType,
  );
  await adapter.setConnectorAccountCredentialRef({
    accountId: args.account.id,
    credentialType: args.credentialType,
    vaultRef,
    metadata: {},
    expiresAt: args.expiresAt,
    lastVerifiedAt: Date.now(),
  });
}

export class DefaultMicrosoftCalendarTokenResolver
  implements MicrosoftCalendarTokenResolver
{
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(
    account: ConnectorAccount,
  ): Promise<MicrosoftCalendarAccessToken> {
    if (hasPlaintextCredentialMetadata(account)) {
      throw new ElizaError(
        "Microsoft connector credentials must be stored as secret references.",
        {
          code: "MICROSOFT_PLAINTEXT_CREDENTIAL_REJECTED",
          context: { connectorAccountId: account.id },
          severity: "fatal",
        },
      );
    }
    const refs = await loadCredentialRefs(this.runtime, account);
    if (refs.length === 0) {
      throw new ElizaError(
        "Microsoft connector account has no OAuth credential references.",
        {
          code: "MICROSOFT_CREDENTIAL_REFS_MISSING",
          context: { connectorAccountId: account.id },
          severity: "fatal",
        },
      );
    }
    const material = await readTokenMaterial(this.runtime, refs);
    if (
      material.accessToken &&
      (material.expiresAt === null || material.expiresAt > this.now() + 60_000)
    ) {
      return {
        value: material.accessToken,
        expiresAt: material.expiresAt,
      };
    }
    if (!material.refreshToken) {
      throw new ElizaError(
        "Microsoft OAuth access token is unavailable or expired and no refresh credential is stored.",
        {
          code: "MICROSOFT_OAUTH_REAUTH_REQUIRED",
          context: { connectorAccountId: account.id },
          severity: "fatal",
        },
      );
    }
    const refreshed = await refreshMicrosoftToken({
      runtime: this.runtime,
      account,
      refreshToken: material.refreshToken,
      scopes: grantedScopes(account),
    });
    await persistRotatedCredential({
      runtime: this.runtime,
      account,
      existingRef: material.accessRef,
      credentialType: "oauth.access_token",
      value: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
    });
    if (refreshed.refreshToken) {
      await persistRotatedCredential({
        runtime: this.runtime,
        account,
        existingRef: material.refreshRef,
        credentialType: "oauth.refresh_token",
        value: refreshed.refreshToken,
        expiresAt: null,
      });
    }
    return {
      value: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
    };
  }
}
