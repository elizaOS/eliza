/**
 * Connects delegated Microsoft Graph accounts (calendar, Outlook mail,
 * contacts, and files capabilities with incremental consent) through the
 * runtime's shared connector-account OAuth boundary. Authorization uses PKCE,
 * state, and a signed nonce-bearing ID token; account identity comes from
 * Microsoft Graph.
 * Token material is committed only to a durable secret backend and represented
 * in account storage by credential references.
 */

import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import {
  CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE,
  type ConnectorAccount,
  type ConnectorAccountManager,
  type ConnectorAccountPatch,
  type ConnectorAccountProvider,
  type ConnectorAccountPurpose,
  type ConnectorAccountRole,
  type ConnectorOAuthCallbackRequest,
  type ConnectorOAuthCallbackResult,
  type ConnectorOAuthStartRequest,
  type ConnectorOAuthStartResult,
  ElizaError,
  type IAgentRuntime,
  logger,
} from "@elizaos/core";
import type { LifeOpsMicrosoftCapability } from "@elizaos/shared";
import { MICROSOFT_CALENDAR_PROVIDER } from "./accounts.js";

const MICROSOFT_LOGIN_ROOT = "https://login.microsoftonline.com";
const MICROSOFT_GRAPH_ME_ENDPOINT =
  "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName,userType";
const MICROSOFT_JWKS_ENDPOINT =
  "https://login.microsoftonline.com/common/discovery/v2.0/keys";
const MICROSOFT_CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const OAUTH_FLOW_TTL_MS = 10 * 60 * 1_000;
const CLOCK_SKEW_SECONDS = 60;
const MICROSOFT_HTTP_TIMEOUT_MS = 15_000;
const MICROSOFT_MAX_JSON_BYTES = 1_048_576;
const MICROSOFT_IDENTITY_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
] as const;
const MICROSOFT_CONNECTOR_CAPABILITIES = [
  "microsoft.calendar.read_basic",
  "microsoft.calendar.read",
  "microsoft.calendar.freebusy",
  "microsoft.calendar.write",
  "microsoft.mail.triage",
  "microsoft.mail.send",
  "microsoft.mail.manage",
  "microsoft.contacts.read",
  "microsoft.files.read",
] as const satisfies readonly LifeOpsMicrosoftCapability[];
// Durable secret writers only. The in-memory core SECRETS service is
// deliberately absent: tokens written there die with the process while the
// persisted vaultRef dangles (#18080).
const SECRET_SERVICE_TYPES = [
  "connector_credential_store",
  "CONNECTOR_CREDENTIAL_STORE",
  "connectorCredentialStore",
  "credential_store",
  "vault",
  "VAULT",
] as const;
const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "tokens",
]);

type MicrosoftConnectorCapability =
  (typeof MICROSOFT_CONNECTOR_CAPABILITIES)[number];
type JsonScalar = string | number | boolean | null;
type JsonValue =
  | JsonScalar
  | JsonValue[]
  | { readonly [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;
type UnknownRecord = Record<string, unknown>;

interface MicrosoftOAuthConfig {
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  tenant: string;
}

interface MicrosoftTokenSet {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  tokenType: "Bearer";
  expiresAt: number;
  grantedScopes: string[];
}

interface MicrosoftIdentity {
  objectId: string;
  displayName: string | null;
  email: string | null;
  userType: string | null;
  tenantId: string;
  accountKind: "organization" | "personal";
}

interface CredentialRef {
  credentialType: string;
  vaultRef: string;
  expiresAt?: number;
  metadata?: JsonRecord;
}

interface SecretBackend {
  name: string;
  put(args: {
    vaultRef: string;
    accountId: string;
    credentialType: string;
    value: string;
  }): Promise<string>;
  remove(vaultRef: string): Promise<void>;
}

interface CredentialRefWriter {
  write(accountId: string, ref: CredentialRef): Promise<void>;
}

interface CredentialRefReader {
  list(accountId: string): Promise<unknown>;
}

interface ParsedJwt {
  header: UnknownRecord;
  claims: UnknownRecord;
  signingInput: string;
  signature: Buffer;
}

interface JwkKey {
  kid: string;
  kty: "RSA";
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function numericValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function member(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? Reflect.get(value, key)
    : undefined;
}

function runtimeFetch(runtime: IAgentRuntime): typeof fetch {
  return runtime.fetch ? runtime.fetch.bind(runtime) : globalThis.fetch;
}

async function microsoftRequest(args: {
  runtime: IAgentRuntime;
  input: string;
  init?: RequestInit;
  message: string;
  code: string;
}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    MICROSOFT_HTTP_TIMEOUT_MS,
  );
  timeout.unref?.();
  try {
    return await runtimeFetch(args.runtime)(args.input, {
      ...args.init,
      redirect: "error",
      signal: controller.signal,
    });
  } catch (cause) {
    // error-policy:J2 Add a stable connector classification to transport
    // failures while preserving the original timeout/network cause.
    throw new ElizaError(args.message, {
      code: args.code,
      cause,
      severity: "ephemeral",
    });
  } finally {
    clearTimeout(timeout);
  }
}

function readSetting(runtime: IAgentRuntime, key: string): string | null {
  return stringValue(runtime.getSetting(key));
}

function validTenant(value: string): boolean {
  return (
    value === "common" ||
    value === "organizations" ||
    value === "consumers" ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function readOAuthConfig(runtime: IAgentRuntime): MicrosoftOAuthConfig {
  const clientId = readSetting(runtime, "MICROSOFT_CLIENT_ID");
  const redirectUri = readSetting(runtime, "MICROSOFT_REDIRECT_URI");
  if (!clientId || !redirectUri) {
    throw new ElizaError(
      "Microsoft OAuth requires MICROSOFT_CLIENT_ID and MICROSOFT_REDIRECT_URI.",
      {
        code: "MICROSOFT_OAUTH_CONFIG_MISSING",
        context: {
          clientIdConfigured: Boolean(clientId),
          redirectUriConfigured: Boolean(redirectUri),
        },
        severity: "fatal",
      },
    );
  }
  let parsedRedirect: URL;
  try {
    parsedRedirect = new URL(redirectUri);
  } catch (cause) {
    // error-policy:J3 Redirect configuration is untrusted deployment input and
    // must produce an explicit invalid configuration result.
    throw new ElizaError("Microsoft OAuth redirect URI is invalid.", {
      code: "MICROSOFT_OAUTH_REDIRECT_INVALID",
      cause,
      severity: "fatal",
    });
  }
  const loopbackHttp =
    parsedRedirect.protocol === "http:" &&
    (parsedRedirect.hostname === "localhost" ||
      parsedRedirect.hostname === "127.0.0.1" ||
      parsedRedirect.hostname === "[::1]");
  if (parsedRedirect.protocol !== "https:" && !loopbackHttp) {
    throw new ElizaError(
      "Microsoft OAuth redirect URI must use HTTPS or a loopback HTTP host.",
      {
        code: "MICROSOFT_OAUTH_REDIRECT_INVALID",
        context: { protocol: parsedRedirect.protocol },
        severity: "fatal",
      },
    );
  }
  if (parsedRedirect.username || parsedRedirect.password) {
    throw new ElizaError(
      "Microsoft OAuth redirect URI must not contain credentials.",
      {
        code: "MICROSOFT_OAUTH_REDIRECT_INVALID",
        severity: "fatal",
      },
    );
  }
  const tenant = (
    readSetting(runtime, "MICROSOFT_TENANT_ID") ?? "common"
  ).toLowerCase();
  if (!validTenant(tenant)) {
    throw new ElizaError("Microsoft OAuth tenant is invalid.", {
      code: "MICROSOFT_OAUTH_TENANT_INVALID",
      context: { tenant },
      severity: "fatal",
    });
  }
  return {
    clientId,
    clientSecret: readSetting(runtime, "MICROSOFT_CLIENT_SECRET"),
    redirectUri: parsedRedirect.toString(),
    tenant,
  };
}

function normalizedScopeName(scope: string): string {
  const normalized = scope.trim();
  const lastPathSegment = normalized.split("/").at(-1) ?? normalized;
  return lastPathSegment.toLowerCase();
}

function capabilityForInput(
  value: string,
): MicrosoftConnectorCapability | "identity" | null {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "microsoft.basic_identity" ||
    MICROSOFT_IDENTITY_SCOPES.some(
      (scope) => scope.toLowerCase() === normalized,
    )
  ) {
    return "identity";
  }
  if (isMicrosoftConnectorCapability(normalized)) {
    return normalized;
  }
  switch (normalizedScopeName(normalized)) {
    case "calendars.readbasic":
      return "microsoft.calendar.read_basic";
    case "calendars.read":
      return "microsoft.calendar.read";
    case "calendars.readwrite":
      return "microsoft.calendar.write";
    case "mail.read":
      return "microsoft.mail.triage";
    case "mail.send":
      return "microsoft.mail.send";
    case "mail.readwrite":
      return "microsoft.mail.manage";
    case "contacts.read":
      return "microsoft.contacts.read";
    case "files.read":
      return "microsoft.files.read";
    default:
      return null;
  }
}

function isMicrosoftConnectorCapability(
  value: string,
): value is MicrosoftConnectorCapability {
  return (MICROSOFT_CONNECTOR_CAPABILITIES as readonly string[]).includes(
    value,
  );
}

function normalizeRequestedCapabilities(
  requested: readonly string[] | undefined,
): MicrosoftConnectorCapability[] {
  if (!requested || requested.length === 0) {
    return ["microsoft.calendar.read"];
  }
  const capabilities = new Set<MicrosoftConnectorCapability>();
  for (const value of requested) {
    const normalized = stringValue(value);
    const capability = normalized ? capabilityForInput(normalized) : null;
    if (!capability) {
      throw new ElizaError(
        "Microsoft OAuth capability or scope is not recognized.",
        {
          code: "MICROSOFT_OAUTH_SCOPE_UNRECOGNIZED",
          context: {
            requestedValueFingerprint: createHash("sha256")
              .update(String(value))
              .digest("hex")
              .slice(0, 16),
          },
          severity: "fatal",
        },
      );
    }
    if (capability !== "identity") capabilities.add(capability);
  }
  if (capabilities.size === 0) {
    throw new ElizaError(
      "Microsoft OAuth requires an explicit Graph capability beyond identity.",
      {
        code: "MICROSOFT_OAUTH_CALENDAR_CAPABILITY_REQUIRED",
        severity: "fatal",
      },
    );
  }
  return [...capabilities];
}

function calendarPrivilege(
  capabilities: readonly MicrosoftConnectorCapability[],
): 0 | 1 | 2 | 3 {
  if (capabilities.includes("microsoft.calendar.write")) return 3;
  if (capabilities.includes("microsoft.calendar.read")) return 2;
  if (
    capabilities.includes("microsoft.calendar.read_basic") ||
    capabilities.includes("microsoft.calendar.freebusy")
  ) {
    return 1;
  }
  return 0;
}

function mailReadPrivilege(
  capabilities: readonly MicrosoftConnectorCapability[],
): 0 | 1 | 2 {
  if (capabilities.includes("microsoft.mail.manage")) return 2;
  if (capabilities.includes("microsoft.mail.triage")) return 1;
  return 0;
}

const CALENDAR_SCOPE_BY_PRIVILEGE = [
  null,
  "Calendars.ReadBasic",
  "Calendars.Read",
  "Calendars.ReadWrite",
] as const;
const MAIL_SCOPE_BY_PRIVILEGE = [null, "Mail.Read", "Mail.ReadWrite"] as const;

/**
 * Incremental-consent scope request: only the Graph permissions for the
 * capabilities the caller asked for are placed on the authorization URL, so a
 * mail-only or contacts-only connect never prompts for calendar access.
 */
function requestedScopes(
  capabilities: readonly MicrosoftConnectorCapability[],
): string[] {
  const scopes: string[] = [...MICROSOFT_IDENTITY_SCOPES];
  const calendarScope =
    CALENDAR_SCOPE_BY_PRIVILEGE[calendarPrivilege(capabilities)];
  if (calendarScope) scopes.push(calendarScope);
  const mailScope = MAIL_SCOPE_BY_PRIVILEGE[mailReadPrivilege(capabilities)];
  if (mailScope) scopes.push(mailScope);
  if (capabilities.includes("microsoft.mail.send")) scopes.push("Mail.Send");
  if (capabilities.includes("microsoft.contacts.read")) {
    scopes.push("Contacts.Read");
  }
  if (capabilities.includes("microsoft.files.read")) scopes.push("Files.Read");
  return scopes;
}

function roleFromMetadata(metadata: unknown): ConnectorAccountRole {
  const values = record(metadata);
  const role = stringValue(
    values?.connectionRole ??
      values?.role ??
      values?.accountRole ??
      values?.requestedRole,
  )?.toUpperCase();
  return role === "OWNER" || role === "AGENT" || role === "TEAM"
    ? role
    : "OWNER";
}

function createCodeVerifier(): string {
  return randomBytes(64).toString("base64url");
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function callbackState(request: ConnectorOAuthCallbackRequest): string | null {
  return (
    stringValue(request.query.state) ?? stringValue(record(request.body)?.state)
  );
}

function flowMetadata(request: ConnectorOAuthCallbackRequest): UnknownRecord {
  return record(request.flow.metadata) ?? {};
}

function assertCallbackPreconditions(request: ConnectorOAuthCallbackRequest): {
  code: string;
  codeVerifier: string;
  nonce: string;
} {
  if (request.flow.status !== "pending") {
    throw new ElizaError("Microsoft OAuth flow is not pending.", {
      code: "MICROSOFT_OAUTH_FLOW_NOT_PENDING",
      context: { flowId: request.flow.id, status: request.flow.status },
      severity: "fatal",
    });
  }
  const returnedState = callbackState(request);
  if (returnedState && !safeEqual(returnedState, request.flow.state)) {
    throw new ElizaError("Microsoft OAuth callback state does not match.", {
      code: "MICROSOFT_OAUTH_STATE_MISMATCH",
      context: { flowId: request.flow.id },
      severity: "fatal",
    });
  }
  const code = stringValue(request.code);
  if (!code) {
    throw new ElizaError(
      "Microsoft OAuth callback is missing an authorization code.",
      {
        code: "MICROSOFT_OAUTH_CODE_MISSING",
        context: { flowId: request.flow.id },
        severity: "fatal",
      },
    );
  }
  const codeVerifier = stringValue(request.flow.codeVerifier);
  if (!codeVerifier) {
    throw new ElizaError(
      "Microsoft OAuth callback is missing its PKCE verifier.",
      {
        code: "MICROSOFT_OAUTH_PKCE_VERIFIER_MISSING",
        context: { flowId: request.flow.id },
        severity: "fatal",
      },
    );
  }
  const nonce = stringValue(flowMetadata(request).nonce);
  if (!nonce) {
    throw new ElizaError(
      "Microsoft OAuth callback is missing its nonce binding.",
      {
        code: "MICROSOFT_OAUTH_NONCE_MISSING",
        context: { flowId: request.flow.id },
        severity: "fatal",
      },
    );
  }
  return { code, codeVerifier, nonce };
}

async function jsonObjectResponse(args: {
  response: Response;
  message: string;
  code: string;
}): Promise<UnknownRecord> {
  const contentType = args.response.headers.get("content-type")?.toLowerCase();
  if (
    !contentType ||
    (!contentType.startsWith("application/json") &&
      !contentType.includes("+json"))
  ) {
    throw new ElizaError(args.message, {
      code: args.code,
      context: { contentType: contentType ?? null },
      severity: "fatal",
    });
  }
  const declaredLength = Number(
    args.response.headers.get("content-length") ?? "0",
  );
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MICROSOFT_MAX_JSON_BYTES
  ) {
    throw new ElizaError(args.message, {
      code: args.code,
      context: {
        declaredLength,
        maxBytes: MICROSOFT_MAX_JSON_BYTES,
      },
      severity: "fatal",
    });
  }
  if (!args.response.body) {
    throw new ElizaError(args.message, {
      code: args.code,
      context: { reason: "missing_body" },
      severity: "fatal",
    });
  }
  const reader = args.response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    receivedBytes += chunk.value.byteLength;
    if (receivedBytes > MICROSOFT_MAX_JSON_BYTES) {
      await reader.cancel();
      throw new ElizaError(args.message, {
        code: args.code,
        context: {
          receivedBytes,
          maxBytes: MICROSOFT_MAX_JSON_BYTES,
        },
        severity: "fatal",
      });
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (cause) {
    // error-policy:J3 OAuth and Graph payloads are untrusted provider input;
    // malformed JSON is an explicit invalid response.
    throw new ElizaError(args.message, {
      code: args.code,
      cause,
      severity: "fatal",
    });
  }
  const parsed = record(payload);
  if (!parsed) {
    throw new ElizaError(args.message, {
      code: args.code,
      severity: "fatal",
    });
  }
  return parsed;
}

function canonicalGrantedScope(scope: string): string | null {
  const normalized = normalizedScopeName(scope);
  const identity = MICROSOFT_IDENTITY_SCOPES.find(
    (candidate) => candidate.toLowerCase() === normalized,
  );
  if (identity) return identity;
  switch (normalized) {
    case "calendars.readbasic":
      return "Calendars.ReadBasic";
    case "calendars.read":
      return "Calendars.Read";
    case "calendars.readwrite":
      return "Calendars.ReadWrite";
    case "mail.read":
      return "Mail.Read";
    case "mail.send":
      return "Mail.Send";
    case "mail.readwrite":
      return "Mail.ReadWrite";
    case "contacts.read":
      return "Contacts.Read";
    case "files.read":
      return "Files.Read";
    default:
      return null;
  }
}

function validateGrantedScopes(args: {
  rawScope: string;
  requestedCapabilities: readonly MicrosoftConnectorCapability[];
}): string[] {
  const scopes = args.rawScope
    .split(/\s+/u)
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (scopes.length === 0) {
    throw new ElizaError(
      "Microsoft OAuth token response did not disclose granted scopes.",
      {
        code: "MICROSOFT_OAUTH_GRANTED_SCOPES_MISSING",
        severity: "fatal",
      },
    );
  }
  const canonical = new Set<string>();
  for (const scope of scopes) {
    const known = canonicalGrantedScope(scope);
    if (!known) {
      throw new ElizaError(
        "Microsoft OAuth returned an unrecognized granted scope.",
        {
          code: "MICROSOFT_OAUTH_GRANTED_SCOPE_UNRECOGNIZED",
          context: { scope },
          severity: "fatal",
        },
      );
    }
    canonical.add(known);
  }
  if (!canonical.has("User.Read")) {
    throw new ElizaError(
      "Microsoft OAuth did not grant the identity permission required for account discovery.",
      {
        code: "MICROSOFT_OAUTH_IDENTITY_SCOPE_MISSING",
        severity: "fatal",
      },
    );
  }
  const assertExactPrivilege = (
    domain: "calendar" | "mail",
    grantedPrivilege: number,
    requiredPrivilege: number,
    missingCode: string,
  ): void => {
    if (grantedPrivilege < requiredPrivilege) {
      throw new ElizaError(
        `Microsoft OAuth did not grant the requested ${domain} capability.`,
        {
          code: missingCode,
          context: { domain, requiredPrivilege, grantedPrivilege },
          severity: "fatal",
        },
      );
    }
    if (grantedPrivilege > requiredPrivilege) {
      throw new ElizaError(
        `Microsoft OAuth returned broader ${domain} access than requested.`,
        {
          code: "MICROSOFT_OAUTH_SCOPE_ESCALATION",
          context: { domain, requiredPrivilege, grantedPrivilege },
          severity: "fatal",
        },
      );
    }
  };
  const assertExactBooleanScope = (
    domain: "mail.send" | "contacts" | "files",
    scope: string,
    requested: boolean,
  ): void => {
    const granted = canonical.has(scope);
    if (requested && !granted) {
      throw new ElizaError(
        `Microsoft OAuth did not grant the requested ${domain} capability.`,
        {
          code: "MICROSOFT_OAUTH_GRANTED_SCOPE_MISSING",
          context: { domain, scope },
          severity: "fatal",
        },
      );
    }
    if (!requested && granted) {
      throw new ElizaError(
        `Microsoft OAuth returned unrequested ${domain} access.`,
        {
          code: "MICROSOFT_OAUTH_SCOPE_ESCALATION",
          context: { domain, scope },
          severity: "fatal",
        },
      );
    }
  };
  const grantedCalendarPrivilege = canonical.has("Calendars.ReadWrite")
    ? 3
    : canonical.has("Calendars.Read")
      ? 2
      : canonical.has("Calendars.ReadBasic")
        ? 1
        : 0;
  assertExactPrivilege(
    "calendar",
    grantedCalendarPrivilege,
    calendarPrivilege(args.requestedCapabilities),
    "MICROSOFT_OAUTH_CALENDAR_SCOPE_MISSING",
  );
  const grantedMailPrivilege = canonical.has("Mail.ReadWrite")
    ? 2
    : canonical.has("Mail.Read")
      ? 1
      : 0;
  assertExactPrivilege(
    "mail",
    grantedMailPrivilege,
    mailReadPrivilege(args.requestedCapabilities),
    "MICROSOFT_OAUTH_GRANTED_SCOPE_MISSING",
  );
  assertExactBooleanScope(
    "mail.send",
    "Mail.Send",
    args.requestedCapabilities.includes("microsoft.mail.send"),
  );
  assertExactBooleanScope(
    "contacts",
    "Contacts.Read",
    args.requestedCapabilities.includes("microsoft.contacts.read"),
  );
  assertExactBooleanScope(
    "files",
    "Files.Read",
    args.requestedCapabilities.includes("microsoft.files.read"),
  );
  return [...canonical];
}

async function exchangeAuthorizationCode(args: {
  runtime: IAgentRuntime;
  config: MicrosoftOAuthConfig;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  scopes: readonly string[];
  requestedCapabilities: readonly MicrosoftConnectorCapability[];
}): Promise<MicrosoftTokenSet> {
  const params = new URLSearchParams({
    client_id: args.config.clientId,
    code: args.code,
    redirect_uri: args.redirectUri,
    grant_type: "authorization_code",
    code_verifier: args.codeVerifier,
    scope: args.scopes.join(" "),
  });
  if (args.config.clientSecret) {
    params.set("client_secret", args.config.clientSecret);
  }
  const response = await microsoftRequest({
    runtime: args.runtime,
    input: `${MICROSOFT_LOGIN_ROOT}/${args.config.tenant}/oauth2/v2.0/token`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    },
    message: "Microsoft OAuth token exchange failed.",
    code: "MICROSOFT_OAUTH_TOKEN_EXCHANGE_FAILED",
  });
  if (!response.ok) {
    throw new ElizaError("Microsoft OAuth token exchange failed.", {
      code: "MICROSOFT_OAUTH_TOKEN_EXCHANGE_FAILED",
      context: { status: response.status },
      severity:
        response.status === 429 || response.status >= 500
          ? "ephemeral"
          : "fatal",
    });
  }
  const payload = await jsonObjectResponse({
    response,
    message: "Microsoft OAuth token exchange returned an invalid payload.",
    code: "MICROSOFT_OAUTH_TOKEN_RESPONSE_INVALID",
  });
  const accessToken = stringValue(payload.access_token);
  const refreshToken = stringValue(payload.refresh_token);
  const idToken = stringValue(payload.id_token);
  const tokenType = stringValue(payload.token_type);
  const expiresIn = numericValue(payload.expires_in);
  const rawScope = stringValue(payload.scope);
  if (
    !accessToken ||
    !refreshToken ||
    !idToken ||
    tokenType?.toLowerCase() !== "bearer" ||
    !expiresIn ||
    expiresIn <= 0 ||
    !rawScope
  ) {
    throw new ElizaError(
      "Microsoft OAuth token exchange returned incomplete credentials.",
      {
        code: "MICROSOFT_OAUTH_TOKEN_RESPONSE_INVALID",
        context: {
          hasAccessToken: Boolean(accessToken),
          hasRefreshToken: Boolean(refreshToken),
          hasIdToken: Boolean(idToken),
          tokenTypeValid: tokenType?.toLowerCase() === "bearer",
          expiresInValid: Boolean(expiresIn && expiresIn > 0),
          hasScope: Boolean(rawScope),
        },
        severity: "fatal",
      },
    );
  }
  return {
    accessToken,
    refreshToken,
    idToken,
    tokenType: "Bearer",
    expiresAt: Date.now() + expiresIn * 1_000,
    grantedScopes: validateGrantedScopes({
      rawScope,
      requestedCapabilities: args.requestedCapabilities,
    }),
  };
}

function parseJwtPart(value: string, part: "header" | "claims"): UnknownRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
  } catch (cause) {
    // error-policy:J3 The ID token is provider input; malformed JWT JSON is an
    // explicit invalid-token result.
    throw new ElizaError(`Microsoft ID token ${part} is invalid.`, {
      code: "MICROSOFT_OAUTH_ID_TOKEN_INVALID",
      cause,
      severity: "fatal",
    });
  }
  const result = record(parsed);
  if (!result) {
    throw new ElizaError(`Microsoft ID token ${part} is invalid.`, {
      code: "MICROSOFT_OAUTH_ID_TOKEN_INVALID",
      severity: "fatal",
    });
  }
  return result;
}

function parseJwt(token: string): ParsedJwt {
  const segments = token.split(".");
  if (segments.length !== 3) {
    throw new ElizaError("Microsoft ID token is not a compact JWT.", {
      code: "MICROSOFT_OAUTH_ID_TOKEN_INVALID",
      severity: "fatal",
    });
  }
  const [headerPart, claimsPart, signaturePart] = segments;
  if (!headerPart || !claimsPart || !signaturePart) {
    throw new ElizaError("Microsoft ID token is incomplete.", {
      code: "MICROSOFT_OAUTH_ID_TOKEN_INVALID",
      severity: "fatal",
    });
  }
  const signature = Buffer.from(signaturePart, "base64url");
  if (signature.length === 0) {
    throw new ElizaError("Microsoft ID token signature is missing.", {
      code: "MICROSOFT_OAUTH_ID_TOKEN_INVALID",
      severity: "fatal",
    });
  }
  return {
    header: parseJwtPart(headerPart, "header"),
    claims: parseJwtPart(claimsPart, "claims"),
    signingInput: `${headerPart}.${claimsPart}`,
    signature,
  };
}

function parseJwk(value: unknown): JwkKey | null {
  const item = record(value);
  const kid = stringValue(item?.kid);
  const kty = stringValue(item?.kty);
  const n = stringValue(item?.n);
  const e = stringValue(item?.e);
  if (!kid || kty !== "RSA" || !n || !e) return null;
  return {
    kid,
    kty: "RSA",
    n,
    e,
    ...(stringValue(item?.alg)
      ? { alg: stringValue(item?.alg) ?? undefined }
      : {}),
    ...(stringValue(item?.use)
      ? { use: stringValue(item?.use) ?? undefined }
      : {}),
  };
}

async function verifyMicrosoftIdToken(args: {
  runtime: IAgentRuntime;
  token: string;
  clientId: string;
  nonce: string;
}): Promise<{ tenantId: string }> {
  const parsed = parseJwt(args.token);
  const algorithm = stringValue(parsed.header.alg);
  const kid = stringValue(parsed.header.kid);
  if (algorithm !== "RS256" || !kid) {
    throw new ElizaError(
      "Microsoft ID token must use a known RS256 signing key.",
      {
        code: "MICROSOFT_OAUTH_ID_TOKEN_ALGORITHM_INVALID",
        severity: "fatal",
      },
    );
  }
  const jwksResponse = await microsoftRequest({
    runtime: args.runtime,
    input: MICROSOFT_JWKS_ENDPOINT,
    message: "Microsoft signing keys could not be loaded.",
    code: "MICROSOFT_OAUTH_JWKS_UNAVAILABLE",
  });
  if (!jwksResponse.ok) {
    throw new ElizaError("Microsoft signing keys could not be loaded.", {
      code: "MICROSOFT_OAUTH_JWKS_UNAVAILABLE",
      context: { status: jwksResponse.status },
      severity:
        jwksResponse.status === 429 || jwksResponse.status >= 500
          ? "ephemeral"
          : "fatal",
    });
  }
  const jwks = await jsonObjectResponse({
    response: jwksResponse,
    message: "Microsoft signing-key response is invalid.",
    code: "MICROSOFT_OAUTH_JWKS_INVALID",
  });
  const keys = Array.isArray(jwks.keys)
    ? jwks.keys.map(parseJwk).filter((key): key is JwkKey => key !== null)
    : [];
  const key = keys.find(
    (candidate) =>
      candidate.kid === kid &&
      (!candidate.alg || candidate.alg === "RS256") &&
      (!candidate.use || candidate.use === "sig"),
  );
  if (!key) {
    throw new ElizaError("Microsoft ID token signing key is not recognized.", {
      code: "MICROSOFT_OAUTH_ID_TOKEN_KEY_UNKNOWN",
      context: { kid },
      severity: "fatal",
    });
  }
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey({
      key: { kty: key.kty, n: key.n, e: key.e },
      format: "jwk",
    });
  } catch (cause) {
    // error-policy:J3 Microsoft signing-key material is untrusted provider
    // input and must produce an explicit invalid-key result.
    throw new ElizaError("Microsoft signing key is invalid.", {
      code: "MICROSOFT_OAUTH_JWKS_INVALID",
      cause,
      context: { kid },
      severity: "fatal",
    });
  }
  if (
    !verifySignature(
      "RSA-SHA256",
      Buffer.from(parsed.signingInput),
      publicKey,
      parsed.signature,
    )
  ) {
    throw new ElizaError("Microsoft ID token signature is invalid.", {
      code: "MICROSOFT_OAUTH_ID_TOKEN_SIGNATURE_INVALID",
      context: { kid },
      severity: "fatal",
    });
  }
  const audiences =
    typeof parsed.claims.aud === "string"
      ? [parsed.claims.aud]
      : Array.isArray(parsed.claims.aud)
        ? parsed.claims.aud.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
  if (!audiences.includes(args.clientId)) {
    throw new ElizaError("Microsoft ID token audience is invalid.", {
      code: "MICROSOFT_OAUTH_ID_TOKEN_AUDIENCE_INVALID",
      severity: "fatal",
    });
  }
  const now = Math.floor(Date.now() / 1_000);
  const expiresAt = numericValue(parsed.claims.exp);
  const notBefore = numericValue(parsed.claims.nbf);
  if (!expiresAt || expiresAt <= now - CLOCK_SKEW_SECONDS) {
    throw new ElizaError("Microsoft ID token has expired.", {
      code: "MICROSOFT_OAUTH_ID_TOKEN_EXPIRED",
      severity: "fatal",
    });
  }
  if (notBefore && notBefore > now + CLOCK_SKEW_SECONDS) {
    throw new ElizaError("Microsoft ID token is not valid yet.", {
      code: "MICROSOFT_OAUTH_ID_TOKEN_NOT_ACTIVE",
      severity: "fatal",
    });
  }
  const returnedNonce = stringValue(parsed.claims.nonce);
  if (!returnedNonce || !safeEqual(returnedNonce, args.nonce)) {
    throw new ElizaError("Microsoft ID token nonce does not match.", {
      code: "MICROSOFT_OAUTH_NONCE_MISMATCH",
      severity: "fatal",
    });
  }
  const tenantId = stringValue(parsed.claims.tid)?.toLowerCase();
  if (
    !tenantId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      tenantId,
    )
  ) {
    throw new ElizaError("Microsoft ID token tenant is invalid.", {
      code: "MICROSOFT_OAUTH_ID_TOKEN_TENANT_INVALID",
      severity: "fatal",
    });
  }
  const issuer = stringValue(parsed.claims.iss)?.replace(/\/+$/u, "");
  const expectedIssuer =
    `${MICROSOFT_LOGIN_ROOT}/${tenantId}/v2.0`.toLowerCase();
  if (issuer?.toLowerCase() !== expectedIssuer) {
    throw new ElizaError("Microsoft ID token issuer is invalid.", {
      code: "MICROSOFT_OAUTH_ID_TOKEN_ISSUER_INVALID",
      context: { tenantId },
      severity: "fatal",
    });
  }
  return { tenantId };
}

async function discoverMicrosoftIdentity(args: {
  runtime: IAgentRuntime;
  accessToken: string;
  tenantId: string;
}): Promise<MicrosoftIdentity> {
  const response = await microsoftRequest({
    runtime: args.runtime,
    input: MICROSOFT_GRAPH_ME_ENDPOINT,
    init: {
      headers: { Authorization: `Bearer ${args.accessToken}` },
    },
    message: "Microsoft Graph account discovery failed.",
    code: "MICROSOFT_GRAPH_IDENTITY_DISCOVERY_FAILED",
  });
  if (!response.ok) {
    throw new ElizaError("Microsoft Graph account discovery failed.", {
      code: "MICROSOFT_GRAPH_IDENTITY_DISCOVERY_FAILED",
      context: { status: response.status },
      severity:
        response.status === 429 || response.status >= 500
          ? "ephemeral"
          : "fatal",
    });
  }
  const profile = await jsonObjectResponse({
    response,
    message: "Microsoft Graph account identity is invalid.",
    code: "MICROSOFT_GRAPH_IDENTITY_INVALID",
  });
  const objectId = stringValue(profile.id);
  if (!objectId) {
    throw new ElizaError(
      "Microsoft Graph account identity did not include an object id.",
      {
        code: "MICROSOFT_GRAPH_IDENTITY_INVALID",
        severity: "fatal",
      },
    );
  }
  const email =
    stringValue(profile.mail) ?? stringValue(profile.userPrincipalName);
  return {
    objectId,
    displayName: stringValue(profile.displayName),
    email: email?.toLowerCase() ?? null,
    userType: stringValue(profile.userType),
    tenantId: args.tenantId,
    accountKind:
      args.tenantId === MICROSOFT_CONSUMER_TENANT_ID
        ? "personal"
        : "organization",
  };
}

function getRuntimeService(
  runtime: IAgentRuntime,
  serviceType: string,
): unknown {
  return runtime.getService(serviceType);
}

function secretBackendForService(args: {
  runtime: IAgentRuntime;
  serviceType: string;
  service: unknown;
}): SecretBackend | null {
  const putSecret = member(args.service, "putSecret");
  const set = member(args.service, "set");
  const remove = member(args.service, "remove");
  if (typeof putSecret === "function" && typeof remove === "function") {
    return {
      name: args.serviceType,
      put: async ({ vaultRef, accountId, credentialType, value }) => {
        const result: unknown = await Reflect.apply(putSecret, args.service, [
          {
            vaultRef,
            agentId: args.runtime.agentId,
            provider: MICROSOFT_CALENDAR_PROVIDER,
            accountId,
            credentialType,
            value,
            caller: "plugin-calendar",
          },
        ]);
        return stringValue(result) ?? vaultRef;
      },
      remove: async (vaultRef) => {
        await Reflect.apply(remove, args.service, [vaultRef]);
      },
    };
  }
  if (typeof set === "function" && typeof remove === "function") {
    return {
      name: args.serviceType,
      put: async ({ vaultRef, value }) => {
        await Reflect.apply(set, args.service, [
          vaultRef,
          value,
          { sensitive: true, caller: "plugin-calendar" },
        ]);
        return vaultRef;
      },
      remove: async (vaultRef) => {
        await Reflect.apply(remove, args.service, [vaultRef]);
      },
    };
  }
  return null;
}

function resolveSecretBackends(runtime: IAgentRuntime): SecretBackend[] {
  const seen = new Set<unknown>();
  const backends: SecretBackend[] = [];
  for (const serviceType of SECRET_SERVICE_TYPES) {
    const service = getRuntimeService(runtime, serviceType);
    if (!service || seen.has(service)) continue;
    seen.add(service);
    const backend = secretBackendForService({ runtime, serviceType, service });
    if (backend) backends.push(backend);
  }
  return backends;
}

function credentialRefWriterFrom(value: unknown): CredentialRefWriter | null {
  const setConnectorRef = member(value, "setConnectorAccountCredentialRef");
  const setRef = member(value, "setCredentialRef");
  const writer =
    typeof setConnectorRef === "function"
      ? setConnectorRef
      : typeof setRef === "function"
        ? setRef
        : null;
  if (!writer) return null;
  return {
    write: async (accountId, ref) => {
      await Reflect.apply(writer, value, [
        {
          accountId,
          credentialType: ref.credentialType,
          vaultRef: ref.vaultRef,
          metadata: ref.metadata,
          ...(ref.expiresAt !== undefined ? { expiresAt: ref.expiresAt } : {}),
          lastVerifiedAt: Date.now(),
        },
      ]);
    },
  };
}

function connectorStorageCandidates(
  runtime: IAgentRuntime,
  manager: ConnectorAccountManager,
): unknown[] {
  return [
    runtime,
    member(runtime, "adapter"),
    manager.getStorage(),
    getRuntimeService(runtime, CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE),
  ].filter((candidate) => candidate !== null && candidate !== undefined);
}

function resolveCredentialRefWriter(args: {
  runtime: IAgentRuntime;
  manager: ConnectorAccountManager;
}): CredentialRefWriter {
  for (const candidate of connectorStorageCandidates(
    args.runtime,
    args.manager,
  )) {
    const writer = credentialRefWriterFrom(candidate);
    if (writer) return writer;
  }
  throw new ElizaError(
    "Microsoft OAuth requires durable connector credential-reference storage.",
    {
      code: "MICROSOFT_CREDENTIAL_REF_WRITER_UNAVAILABLE",
      severity: "fatal",
    },
  );
}

function credentialRefReaderFrom(value: unknown): CredentialRefReader | null {
  const list = member(value, "listConnectorAccountCredentialRefs");
  return typeof list === "function"
    ? {
        list: async (accountId) => Reflect.apply(list, value, [{ accountId }]),
      }
    : null;
}

function resolveCredentialRefReader(args: {
  runtime: IAgentRuntime;
  manager: ConnectorAccountManager;
}): CredentialRefReader | null {
  for (const candidate of connectorStorageCandidates(
    args.runtime,
    args.manager,
  )) {
    const reader = credentialRefReaderFrom(candidate);
    if (reader) return reader;
  }
  return null;
}

function credentialRefFromUnknown(value: unknown): CredentialRef | null {
  const item = record(value);
  const credentialType = stringValue(item?.credentialType ?? item?.type);
  const vaultRef = stringValue(item?.vaultRef ?? item?.ref);
  if (!credentialType || !vaultRef) return null;
  const expiresAt = numericValue(item?.expiresAt);
  const metadata = record(item?.metadata);
  return {
    credentialType,
    vaultRef,
    ...(expiresAt ? { expiresAt } : {}),
    ...(metadata
      ? {
          metadata: Object.fromEntries(
            Object.entries(metadata).filter(
              (entry): entry is [string, JsonValue] => isJsonValue(entry[1]),
            ),
          ),
        }
      : {}),
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  const item = record(value);
  return item ? Object.values(item).every(isJsonValue) : false;
}

function metadataCredentialRefs(metadata: unknown): CredentialRef[] {
  const values = record(metadata);
  const oauth = record(values?.oauth);
  const sources = [
    values?.credentialRefs,
    values?.oauthCredentialRefs,
    oauth?.credentialRefs,
  ];
  const refs: CredentialRef[] = [];
  for (const source of sources) {
    if (Array.isArray(source)) {
      refs.push(
        ...source
          .map(credentialRefFromUnknown)
          .filter((ref): ref is CredentialRef => ref !== null),
      );
      continue;
    }
    const byType = record(source);
    if (!byType) continue;
    for (const [credentialType, entry] of Object.entries(byType)) {
      const item = record(entry);
      const parsed = credentialRefFromUnknown({
        credentialType,
        ...(item ?? { vaultRef: entry }),
      });
      if (parsed) refs.push(parsed);
    }
  }
  return refs;
}

function metadataHasPlaintextCredentials(metadata: unknown): boolean {
  const values = record(metadata);
  const oauth = record(values?.oauth);
  return [...Object.keys(values ?? {}), ...Object.keys(oauth ?? {})].some(
    isForbiddenCredentialKey,
  );
}

function isForbiddenCredentialKey(key: string): boolean {
  return FORBIDDEN_CREDENTIAL_KEYS.has(
    key.toLowerCase().replaceAll("_", "").replaceAll("-", ""),
  );
}

function assertNoPlaintextCredentials(metadata: unknown): void {
  if (metadataHasPlaintextCredentials(metadata)) {
    throw new ElizaError(
      "Microsoft connector credentials must be stored as durable secret references.",
      {
        code: "MICROSOFT_PLAINTEXT_CREDENTIAL_REJECTED",
        severity: "fatal",
      },
    );
  }
}

function sanitizeDisconnectedMetadata(metadata: unknown): UnknownRecord {
  const values = record(metadata) ?? {};
  const oauth = record(values.oauth);
  const sanitized = Object.fromEntries(
    Object.entries(values).filter(
      ([key]) =>
        !isForbiddenCredentialKey(key) &&
        key !== "credentialRefs" &&
        key !== "oauthCredentialRefs",
    ),
  );
  if (oauth) {
    sanitized.oauth = Object.fromEntries(
      Object.entries(oauth).filter(
        ([key]) => !isForbiddenCredentialKey(key) && key !== "credentialRefs",
      ),
    );
  }
  return sanitized;
}

function credentialVaultRef(args: {
  runtime: IAgentRuntime;
  accountId: string;
  credentialType: string;
}): string {
  const fingerprint = (value: string) =>
    createHash("sha256").update(value).digest("hex").slice(0, 24);
  return [
    "connector",
    MICROSOFT_CALENDAR_PROVIDER,
    fingerprint(args.runtime.agentId),
    fingerprint(args.accountId),
    args.credentialType.replaceAll(".", "_"),
  ].join("/");
}

async function persistTokenSet(args: {
  runtime: IAgentRuntime;
  manager: ConnectorAccountManager;
  accountId: string;
  tokens: MicrosoftTokenSet;
}): Promise<CredentialRef> {
  const backend = resolveSecretBackends(args.runtime)[0];
  if (!backend) {
    throw new ElizaError(
      "Microsoft OAuth requires a durable secret backend with write and removal support.",
      {
        code: "MICROSOFT_SECRET_WRITER_UNAVAILABLE",
        severity: "fatal",
      },
    );
  }
  const refWriter = resolveCredentialRefWriter({
    runtime: args.runtime,
    manager: args.manager,
  });
  const credentialType = "oauth.tokens";
  const plannedRef = credentialVaultRef({
    runtime: args.runtime,
    accountId: args.accountId,
    credentialType,
  });
  let vaultRef: string;
  try {
    vaultRef = await backend.put({
      vaultRef: plannedRef,
      accountId: args.accountId,
      credentialType,
      value: JSON.stringify({
        access_token: args.tokens.accessToken,
        refresh_token: args.tokens.refreshToken,
        token_type: args.tokens.tokenType,
        scope: args.tokens.grantedScopes.join(" "),
        expiry_date: args.tokens.expiresAt,
      }),
    });
  } catch (cause) {
    // error-policy:J2 Preserve the secret backend failure while classifying the
    // failed durable OAuth commit.
    throw new ElizaError(
      "Microsoft OAuth credentials could not be written to the secret backend.",
      {
        code: "MICROSOFT_SECRET_WRITE_FAILED",
        cause,
        context: { backend: backend.name },
        severity: "fatal",
      },
    );
  }
  const ref: CredentialRef = {
    credentialType,
    vaultRef,
    expiresAt: args.tokens.expiresAt,
    metadata: {
      connectorAccountId: args.accountId,
      provider: MICROSOFT_CALENDAR_PROVIDER,
      backend: backend.name,
      hasRefreshToken: true,
    },
  };
  try {
    await refWriter.write(args.accountId, ref);
  } catch (cause) {
    try {
      // error-policy:J6 Roll back the just-written secret when the durable
      // reference commit fails; the account remains pending.
      await backend.remove(vaultRef);
    } catch (rollbackCause) {
      // error-policy:J6 The primary ref-write failure remains authoritative;
      // rollback failure is warned because there is no further safe teardown.
      logger.warn(
        {
          src: "plugin:calendar:microsoft-oauth",
          accountId: args.accountId,
          backend: backend.name,
          err:
            rollbackCause instanceof Error
              ? rollbackCause.message
              : String(rollbackCause),
        },
        "Microsoft OAuth credential rollback failed",
      );
    }
    // error-policy:J2 The ref store is the durable-account boundary; preserve
    // its failure without exposing token material.
    throw new ElizaError(
      "Microsoft OAuth credential reference could not be persisted.",
      {
        code: "MICROSOFT_CREDENTIAL_REF_WRITE_FAILED",
        cause,
        context: { backend: backend.name, accountId: args.accountId },
        severity: "fatal",
      },
    );
  }
  return ref;
}

async function allCredentialRefs(args: {
  runtime: IAgentRuntime;
  manager: ConnectorAccountManager;
  account: ConnectorAccount;
}): Promise<CredentialRef[]> {
  const refs = [...metadataCredentialRefs(args.account.metadata)];
  const reader = resolveCredentialRefReader({
    runtime: args.runtime,
    manager: args.manager,
  });
  if (reader) {
    const stored = await reader.list(args.account.id);
    if (!Array.isArray(stored)) {
      throw new ElizaError(
        "Microsoft connector credential-reference storage returned an invalid result.",
        {
          code: "MICROSOFT_CREDENTIAL_REF_LIST_INVALID",
          context: { connectorAccountId: args.account.id },
          severity: "fatal",
        },
      );
    }
    refs.push(
      ...stored
        .map(credentialRefFromUnknown)
        .filter((ref): ref is CredentialRef => ref !== null),
    );
  } else if (refs.length > 0) {
    throw new ElizaError(
      "Microsoft disconnect cannot prove that all rotated credential references were enumerated.",
      {
        code: "MICROSOFT_CREDENTIAL_REF_READER_UNAVAILABLE",
        context: { connectorAccountId: args.account.id },
        severity: "fatal",
      },
    );
  }
  const unique = new Map<string, CredentialRef>();
  for (const ref of refs)
    unique.set(`${ref.credentialType}:${ref.vaultRef}`, ref);
  return [...unique.values()];
}

async function removeLocalCredentials(args: {
  runtime: IAgentRuntime;
  manager: ConnectorAccountManager;
  account: ConnectorAccount;
}): Promise<number> {
  const refs = await allCredentialRefs(args);
  if (refs.length === 0) return 0;
  const backends = resolveSecretBackends(args.runtime);
  if (backends.length === 0) {
    throw new ElizaError(
      "Microsoft disconnect requires a registered secret remover.",
      {
        code: "MICROSOFT_SECRET_REMOVER_UNAVAILABLE",
        context: { connectorAccountId: args.account.id },
        severity: "fatal",
      },
    );
  }
  for (const ref of refs) {
    const preferred = stringValue(ref.metadata?.backend);
    const backend = preferred
      ? backends.find((candidate) => candidate.name === preferred)
      : backends[0];
    if (!backend) {
      throw new ElizaError(
        "Microsoft disconnect could not resolve the credential's secret backend.",
        {
          code: "MICROSOFT_SECRET_REMOVER_UNAVAILABLE",
          context: {
            connectorAccountId: args.account.id,
            backend: preferred,
          },
          severity: "fatal",
        },
      );
    }
    try {
      await backend.remove(ref.vaultRef);
    } catch (cause) {
      // error-policy:J2 Credential deletion is security-sensitive and must fail
      // the disconnect if the authoritative backend cannot remove a token.
      throw new ElizaError(
        "Microsoft connector credential could not be removed.",
        {
          code: "MICROSOFT_SECRET_REMOVE_FAILED",
          cause,
          context: {
            connectorAccountId: args.account.id,
            backend: backend.name,
          },
          severity: "fatal",
        },
      );
    }
  }
  return refs.length;
}

function purposes(
  value: ConnectorAccountPatch["purpose"] | undefined,
  fallback: ConnectorAccountPurpose[],
): ConnectorAccountPurpose[] {
  return Array.isArray(value)
    ? value
    : typeof value === "string" && value.trim()
      ? [value]
      : fallback;
}

function mergeAccountPatch(
  account: ConnectorAccount,
  patch: ConnectorAccountPatch,
): ConnectorAccount {
  return {
    ...account,
    ...patch,
    id: account.id,
    provider: MICROSOFT_CALENDAR_PROVIDER,
    purpose: purposes(patch.purpose, account.purpose),
    externalId:
      patch.externalId === undefined
        ? account.externalId
        : (patch.externalId ?? undefined),
    displayHandle:
      patch.displayHandle === undefined
        ? account.displayHandle
        : (patch.displayHandle ?? undefined),
    ownerBindingId:
      patch.ownerBindingId === undefined
        ? account.ownerBindingId
        : (patch.ownerBindingId ?? undefined),
    ownerIdentityId:
      patch.ownerIdentityId === undefined
        ? account.ownerIdentityId
        : (patch.ownerIdentityId ?? undefined),
    metadata: patch.metadata ?? account.metadata,
    createdAt: account.createdAt,
  };
}

async function accountIdForIdentity(args: {
  manager: ConnectorAccountManager;
  requestedAccountId: string | undefined;
  externalId: string;
}): Promise<string> {
  if (args.requestedAccountId) {
    const existing = await args.manager
      .getStorage()
      .getAccount(MICROSOFT_CALENDAR_PROVIDER, args.requestedAccountId);
    if (!existing) {
      throw new ElizaError(
        "Microsoft OAuth reconnect account does not exist.",
        {
          code: "MICROSOFT_OAUTH_ACCOUNT_NOT_FOUND",
          context: { accountId: args.requestedAccountId },
          severity: "fatal",
        },
      );
    }
    if (existing.externalId && existing.externalId !== args.externalId) {
      throw new ElizaError(
        "Microsoft OAuth reconnect identity does not match the existing account.",
        {
          code: "MICROSOFT_OAUTH_ACCOUNT_IDENTITY_MISMATCH",
          context: { accountId: existing.id },
          severity: "fatal",
        },
      );
    }
    return existing.id;
  }
  const matching = (
    await args.manager.getStorage().listAccounts(MICROSOFT_CALENDAR_PROVIDER)
  ).find((account) => account.externalId === args.externalId);
  return matching?.id ?? randomUUID();
}

function callbackRedirectUri(args: {
  request: ConnectorOAuthCallbackRequest;
  config: MicrosoftOAuthConfig;
}): string {
  const metadataRedirect = stringValue(flowMetadata(args.request).redirectUri);
  const redirect =
    stringValue(args.request.flow.redirectUri) ??
    metadataRedirect ??
    args.config.redirectUri;
  if (redirect !== args.config.redirectUri) {
    throw new ElizaError(
      "Microsoft OAuth callback redirect URI does not match configured redirect URI.",
      {
        code: "MICROSOFT_OAUTH_REDIRECT_MISMATCH",
        context: { flowId: args.request.flow.id },
        severity: "fatal",
      },
    );
  }
  return redirect;
}

function requestedCapabilitiesFromFlow(
  request: ConnectorOAuthCallbackRequest,
): MicrosoftConnectorCapability[] {
  const values = flowMetadata(request).requestedCapabilities;
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    !values.every((value) => typeof value === "string")
  ) {
    throw new ElizaError(
      "Microsoft OAuth flow is missing its requested capability binding.",
      {
        code: "MICROSOFT_OAUTH_CAPABILITY_BINDING_MISSING",
        context: { flowId: request.flow.id },
        severity: "fatal",
      },
    );
  }
  return normalizeRequestedCapabilities(values);
}

/**
 * Builds the Microsoft delegated-calendar account provider registered by the
 * calendar plugin.
 */
export function createMicrosoftConnectorAccountProvider(
  runtime: IAgentRuntime,
): ConnectorAccountProvider {
  return {
    provider: MICROSOFT_CALENDAR_PROVIDER,
    label: "Microsoft Calendar",

    listAccounts: async (
      manager: ConnectorAccountManager,
    ): Promise<ConnectorAccount[]> =>
      manager.getStorage().listAccounts(MICROSOFT_CALENDAR_PROVIDER),

    createAccount: async (input: ConnectorAccountPatch) => {
      assertNoPlaintextCredentials(input.metadata);
      if (input.status === "connected") {
        throw new ElizaError(
          "Microsoft connector accounts can become connected only through a completed OAuth flow.",
          {
            code: "MICROSOFT_OAUTH_REQUIRED",
            severity: "fatal",
          },
        );
      }
      return {
        ...input,
        provider: MICROSOFT_CALENDAR_PROVIDER,
        role: input.role ?? "OWNER",
        purpose: input.purpose ?? ["calendar"],
        accessGate: input.accessGate ?? "open",
        status: input.status ?? "pending",
      };
    },

    patchAccount: async (
      accountId: string,
      patch: ConnectorAccountPatch,
      manager: ConnectorAccountManager,
    ) => {
      assertNoPlaintextCredentials(patch.metadata);
      const existing = await manager
        .getStorage()
        .getAccount(MICROSOFT_CALENDAR_PROVIDER, accountId);
      if (!existing) {
        throw new ElizaError("Microsoft connector account does not exist.", {
          code: "MICROSOFT_ACCOUNT_NOT_FOUND",
          context: { accountId },
          severity: "fatal",
        });
      }
      if (patch.status === "connected" && existing.status !== "connected") {
        throw new ElizaError(
          "Microsoft connector accounts can become connected only through a completed OAuth flow.",
          {
            code: "MICROSOFT_OAUTH_REQUIRED",
            context: { accountId },
            severity: "fatal",
          },
        );
      }
      if (patch.status !== "revoked" && patch.status !== "disabled") {
        return mergeAccountPatch(existing, patch);
      }
      const removed = await removeLocalCredentials({
        runtime,
        manager,
        account: existing,
      });
      return mergeAccountPatch(existing, {
        ...patch,
        metadata: {
          ...sanitizeDisconnectedMetadata(existing.metadata),
          ...sanitizeDisconnectedMetadata(patch.metadata),
          disconnect: {
            localSecretsCleared: removed,
            remoteRevocation: "not_attempted",
            reason:
              "Microsoft identity platform does not expose a per-token revocation endpoint.",
            disconnectedAt: new Date().toISOString(),
          },
        },
      });
    },

    deleteAccount: async (
      accountId: string,
      manager: ConnectorAccountManager,
    ): Promise<void> => {
      const existing = await manager
        .getStorage()
        .getAccount(MICROSOFT_CALENDAR_PROVIDER, accountId);
      if (!existing) return;
      const removed = await removeLocalCredentials({
        runtime,
        manager,
        account: existing,
      });
      logger.info(
        {
          src: "plugin:calendar:microsoft-oauth",
          accountId,
          localSecretsCleared: removed,
          remoteRevocation: "not_attempted",
        },
        "Microsoft connector account disconnected locally",
      );
    },

    startOAuth: async (
      request: ConnectorOAuthStartRequest,
    ): Promise<ConnectorOAuthStartResult> => {
      const config = readOAuthConfig(runtime);
      if (request.redirectUri) {
        let requestedRedirect: string;
        try {
          requestedRedirect = new URL(request.redirectUri).toString();
        } catch (cause) {
          // error-policy:J3 The redirect override is untrusted route input and
          // must produce an explicit invalid-request result.
          throw new ElizaError(
            "Microsoft OAuth redirect URI override is invalid.",
            {
              code: "MICROSOFT_OAUTH_REDIRECT_INVALID",
              cause,
              context: { flowId: request.flow.id },
              severity: "fatal",
            },
          );
        }
        if (requestedRedirect !== config.redirectUri) {
          throw new ElizaError(
            "Microsoft OAuth redirect URI does not match configured redirect URI.",
            {
              code: "MICROSOFT_OAUTH_REDIRECT_MISMATCH",
              context: { flowId: request.flow.id },
              severity: "fatal",
            },
          );
        }
      }
      const capabilities = normalizeRequestedCapabilities(request.scopes);
      const scopes = requestedScopes(capabilities);
      const codeVerifier = createCodeVerifier();
      const nonce = randomBytes(32).toString("base64url");
      const params = new URLSearchParams({
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: config.redirectUri,
        response_mode: "query",
        scope: scopes.join(" "),
        state: request.flow.state,
        nonce,
        prompt: "select_account",
        code_challenge: codeChallenge(codeVerifier),
        code_challenge_method: "S256",
      });
      return {
        authUrl: `${MICROSOFT_LOGIN_ROOT}/${config.tenant}/oauth2/v2.0/authorize?${params.toString()}`,
        expiresAt: Date.now() + OAUTH_FLOW_TTL_MS,
        codeVerifier,
        metadata: {
          ...request.metadata,
          requestedCapabilities: capabilities,
          requestedScopes: scopes,
          redirectUri: config.redirectUri,
          tenant: config.tenant,
          nonce,
          codeChallengeMethod: "S256",
        },
      };
    },

    completeOAuth: async (
      request: ConnectorOAuthCallbackRequest,
      manager: ConnectorAccountManager,
    ): Promise<ConnectorOAuthCallbackResult> => {
      const preconditions = assertCallbackPreconditions(request);
      const config = readOAuthConfig(runtime);
      const redirectUri = callbackRedirectUri({ request, config });
      const capabilities = requestedCapabilitiesFromFlow(request);
      const scopes = requestedScopes(capabilities);
      const tokens = await exchangeAuthorizationCode({
        runtime,
        config,
        redirectUri,
        code: preconditions.code,
        codeVerifier: preconditions.codeVerifier,
        scopes,
        requestedCapabilities: capabilities,
      });
      const idToken = await verifyMicrosoftIdToken({
        runtime,
        token: tokens.idToken,
        clientId: config.clientId,
        nonce: preconditions.nonce,
      });
      const identity = await discoverMicrosoftIdentity({
        runtime,
        accessToken: tokens.accessToken,
        tenantId: idToken.tenantId,
      });
      const externalId = `${identity.tenantId}:${identity.objectId}`;
      const accountId = await accountIdForIdentity({
        manager,
        requestedAccountId: request.flow.accountId,
        externalId,
      });
      const existing = await manager
        .getStorage()
        .getAccount(MICROSOFT_CALENDAR_PROVIDER, accountId);
      assertNoPlaintextCredentials(existing?.metadata);
      const accountMetadata = {
        ...(record(existing?.metadata) ?? {}),
        email: identity.email,
        displayName: identity.displayName,
        userType: identity.userType,
        tenantId: identity.tenantId,
        accountKind: identity.accountKind,
        identity: {
          objectId: identity.objectId,
          email: identity.email,
          tenantId: identity.tenantId,
        },
        requestedCapabilities: capabilities,
        requestedScopes: scopes,
        grantedScopes: tokens.grantedScopes,
        tokenType: tokens.tokenType,
        expiresAt: tokens.expiresAt,
        hasRefreshToken: true,
      };
      const pending = await manager.upsertAccount(
        MICROSOFT_CALENDAR_PROVIDER,
        {
          id: accountId,
          provider: MICROSOFT_CALENDAR_PROVIDER,
          label: identity.displayName ?? identity.email ?? "Microsoft Calendar",
          role: existing?.role ?? roleFromMetadata(request.flow.metadata),
          purpose: existing?.purpose ?? ["calendar"],
          accessGate: existing?.accessGate ?? "open",
          status: "pending",
          externalId,
          displayHandle:
            identity.email ?? identity.displayName ?? identity.objectId,
          ownerBindingId: existing?.ownerBindingId,
          ownerIdentityId: existing?.ownerIdentityId,
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
          metadata: accountMetadata,
        },
        accountId,
      );
      const credentialRef = await persistTokenSet({
        runtime,
        manager,
        accountId: pending.id,
        tokens,
      });
      const connected: ConnectorAccount = {
        ...pending,
        status: "connected",
        metadata: {
          ...accountMetadata,
          credentialRefs: [
            {
              credentialType: credentialRef.credentialType,
              vaultRef: credentialRef.vaultRef,
              expiresAt: credentialRef.expiresAt ?? null,
              metadata: credentialRef.metadata ?? {},
            },
          ],
          credentialVersion: String(Date.now()),
        },
      };
      logger.info(
        {
          src: "plugin:calendar:microsoft-oauth",
          accountId: connected.id,
          tenantId: identity.tenantId,
          accountKind: identity.accountKind,
          grantedScopes: tokens.grantedScopes,
        },
        "Microsoft Calendar OAuth completed",
      );
      return {
        account: connected,
        flow: {
          status: "completed",
          accountId: connected.id,
          metadata: {
            ...flowMetadata(request),
            completedAt: new Date().toISOString(),
          },
        },
      };
    },
  };
}
