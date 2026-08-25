/**
 * Google ConnectorAccountManager provider.
 *
 * Bridges plugin-google-workspace to the @elizaos/core ConnectorAccountManager so the
 * generic HTTP CRUD + OAuth surface (packages/agent/src/api/connector-account-routes.ts)
 * can list, create, patch, delete, and run the OAuth flow for Google accounts
 * using a single consolidated grant covering Gmail, Calendar, Drive, and Meet.
 *
 * Single OAuth grant per account: callers must pass an explicit `scopes`
 * capability subset to the manager's startOAuth. Omitted or empty scope lists
 * fail closed instead of expanding to every supported capability. Granted
 * capabilities are recorded on the returned account so downstream consumers
 * know which surfaces are usable.
 */

import { createHash, randomBytes } from "node:crypto";
import {
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
import { GOOGLE_OAUTH_PROVIDER_METADATA } from "./auth.js";
import { persistConnectorCredentialRefs } from "./connector-credential-refs.js";
import { createGmailMessageConnector } from "./gmail-message-connector.js";
import { resolveGoogleConnectorOAuthCallbackUrl } from "./google-oauth-callback.js";
import {
  GOOGLE_CAPABILITIES,
  GOOGLE_IDENTITY_SCOPES,
  type GoogleCapability,
  type GoogleCapabilityGroup,
  isGoogleCapability,
  scopesForGoogleCapabilities,
} from "./scopes.js";
import { GOOGLE_SERVICE_NAME } from "./types.js";

const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

/** Maximum time allowed for one Google OAuth or userinfo request. */
export const GOOGLE_OAUTH_FETCH_TIMEOUT_MS = 15_000;

const GROUP_PURPOSE: Record<GoogleCapabilityGroup, ConnectorAccountPurpose> = {
  gmail: "messaging" as ConnectorAccountPurpose,
  calendar: "calendar" as ConnectorAccountPurpose,
  drive: "drive" as ConnectorAccountPurpose,
  meet: "meet" as ConnectorAccountPurpose,
  people: "contacts" as ConnectorAccountPurpose,
};

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

interface GoogleIdentity {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
}

interface GoogleCalendarWatchRevocationService {
  revokeGoogleCalendarWatchesByAccount(accountId: string): Promise<void>;
}

function isGoogleCalendarWatchRevocationService(
  value: unknown
): value is GoogleCalendarWatchRevocationService {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Partial<GoogleCalendarWatchRevocationService>)
      .revokeGoogleCalendarWatchesByAccount === "function"
  );
}

function createCodeVerifier(): string {
  return randomBytes(64).toString("base64url");
}

function createCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
  return nonEmptyString(runtime.getSetting?.(key));
}

function readClientConfig(
  runtime: IAgentRuntime,
  servedOrigin?: string
): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const clientId = readSetting(runtime, "GOOGLE_CLIENT_ID");
  const clientSecret = readSetting(runtime, "GOOGLE_CLIENT_SECRET");
  const redirectUri = resolveGoogleConnectorOAuthCallbackUrl(
    runtime,
    servedOrigin ? { servedOrigin } : undefined
  );
  if (!clientId || !clientSecret) {
    throw new Error(
      "Google OAuth requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI to be configured."
    );
  }
  return { clientId, clientSecret, redirectUri };
}

/**
 * Re-auth of an existing account that OMITS `scopes` defaults to exactly the
 * account's recorded granted capabilities — least privilege, re-requesting
 * what was granted and never expanding it (#18543).
 *
 * Branch on property semantics, not length: an explicitly supplied array
 * (including an empty `[]`) is returned unchanged so it flows to
 * normalizeRequestedCapabilities, which fails closed on empty. Per #18454 an
 * explicit empty selection is NOT consent to restore prior authority; only a
 * genuinely omitted field consults the account. New-account starts (no usable
 * `accountId`, no recorded grant) also keep failing closed downstream.
 */
async function resolveRequestedScopes(
  request: ConnectorOAuthStartRequest,
  manager: ConnectorAccountManager
): Promise<readonly string[] | undefined> {
  if (request.scopes !== undefined) {
    return request.scopes;
  }
  const accountId = nonEmptyString(request.accountId);
  if (!accountId) {
    return request.scopes;
  }
  const account = await manager.getAccount(GOOGLE_SERVICE_NAME, accountId);
  const recorded = (account?.metadata as Record<string, unknown> | undefined)?.grantedCapabilities;
  if (!Array.isArray(recorded)) {
    return request.scopes;
  }
  const granted = recorded.filter((value): value is GoogleCapability => isGoogleCapability(value));
  return granted.length > 0 ? granted : request.scopes;
}

function normalizeRequestedCapabilities(scopes: readonly string[] | undefined): GoogleCapability[] {
  if (!scopes || scopes.length === 0) {
    throw new ElizaError(
      "Google OAuth requires an explicit Gmail, Calendar, Drive, or Meet capability selection.",
      {
        code: "GOOGLE_OAUTH_CAPABILITY_REQUIRED",
        context: { scopes: scopes ?? null },
        severity: "fatal",
      }
    );
  }
  // The caller passes either capability identifiers (e.g. "gmail.read") OR raw
  // OAuth scope URLs. Both shapes are accepted so the manager's startOAuth API
  // surface stays uniform with other providers (which use raw scopes).
  const requested = new Set<GoogleCapability>();
  const identityScopes = new Set<string>(
    GOOGLE_IDENTITY_SCOPES.map((scope) => scope.toLowerCase())
  );
  for (const value of scopes) {
    if (isGoogleCapability(value)) {
      requested.add(value);
      continue;
    }
    const matched = matchCapabilityFromScope(value);
    if (matched) {
      requested.add(matched);
      continue;
    }
    if (identityScopes.has(value.trim().toLowerCase())) {
      continue;
    }
    throw new ElizaError(`Google OAuth capability or scope is not recognized: ${value}`, {
      code: "GOOGLE_OAUTH_SCOPE_UNRECOGNIZED",
      context: { scope: value },
      severity: "fatal",
    });
  }
  if (requested.size === 0) {
    throw new ElizaError(
      "Google OAuth requires at least one Gmail, Calendar, Drive, or Meet capability.",
      {
        code: "GOOGLE_OAUTH_CAPABILITY_REQUIRED",
        context: { scopes: [...scopes] },
        severity: "fatal",
      }
    );
  }
  return [...requested];
}

function normalizeGrantedCapabilities(scopes: readonly string[]): {
  capabilities: GoogleCapability[];
  ignoredScopes: string[];
} {
  const capabilities = new Set<GoogleCapability>();
  const grantedScopeSet = new Set<string>();
  const ignoredScopes: string[] = [];
  const identityScopes = new Set(GOOGLE_IDENTITY_SCOPES.map((scope) => scope.toLowerCase()));

  // error-policy:J3 Provider-returned scopes are untrusted external input. Keep
  // exact recognized capabilities, retain unknown scopes as metadata, and make
  // an empty connector grant an explicit failure instead of inventing access.
  for (const scope of scopes) {
    const normalized = scope.trim();
    if (!normalized) continue;
    if (isGoogleCapability(normalized)) {
      capabilities.add(normalized);
      continue;
    }
    const normalizedScope = normalized.toLowerCase();
    if (identityScopes.has(normalizedScope)) {
      continue;
    }
    if (matchCapabilityFromScope(normalized)) {
      grantedScopeSet.add(normalizedScope);
      continue;
    }
    ignoredScopes.push(normalized);
  }

  for (const capability of GOOGLE_CAPABILITIES) {
    if (capabilities.has(capability)) continue;
    const capabilityScopes = scopesForGoogleCapabilities([capability], {
      includeIdentityScopes: false,
    });
    if (capabilityScopes.every((scope) => grantedScopeSet.has(scope.toLowerCase()))) {
      capabilities.add(capability);
    }
  }

  return { capabilities: [...capabilities], ignoredScopes };
}

function matchCapabilityFromScope(scope: string): GoogleCapability | undefined {
  // Scope URL → capability ID mapping. Pulls from the canonical capability
  // metadata so additions to scopes.ts propagate automatically.
  const trimmed = scope.trim().toLowerCase();
  for (const capability of GOOGLE_CAPABILITIES) {
    const capabilityScopes = scopesForGoogleCapabilities([capability], {
      includeIdentityScopes: false,
    });
    if (capabilityScopes.some((value) => value.toLowerCase() === trimmed)) {
      return capability;
    }
  }
  return undefined;
}

function purposesForCapabilities(
  capabilities: readonly GoogleCapability[]
): ConnectorAccountPurpose[] {
  const groups = new Set<GoogleCapabilityGroup>();
  for (const capability of capabilities) {
    groups.add(capability.split(".")[0] as GoogleCapabilityGroup);
  }
  return [...groups].map((group) => GROUP_PURPOSE[group]);
}

function parseScopeString(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") {
    throw new ElizaError("Google token exchange returned an invalid scope field.", {
      code: "GOOGLE_OAUTH_SCOPE_PAYLOAD_INVALID",
      context: { valueType: typeof value },
      severity: "fatal",
    });
  }
  return value
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function requestedScopesFromMetadata(metadata: unknown): string[] {
  if (!isRecord(metadata) || metadata.requestedScopes === undefined) {
    throw new ElizaError(
      "Google OAuth callback is missing the scopes bound to the authorization request.",
      {
        code: "GOOGLE_OAUTH_REQUESTED_SCOPES_MISSING",
        severity: "fatal",
      }
    );
  }
  const scopes = metadata.requestedScopes;
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) {
    throw new ElizaError("Google OAuth callback contains invalid requested-scope metadata.", {
      code: "GOOGLE_OAUTH_REQUESTED_SCOPES_INVALID",
      context: {
        valueType: Array.isArray(scopes) ? "array-with-non-string" : typeof scopes,
      },
      severity: "fatal",
    });
  }
  return scopes;
}

function roleFromMetadata(metadata: unknown): ConnectorAccountRole {
  const record =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  // Cloud OAuth writes `connectionRole` (uppercase canonical) and a legacy
  // lowercase `agentGoogleSide`. Local UI flows pass `role`/`accountRole`/
  // `requestedRole`. Accept all five shapes so the role survives whichever
  // path the OAuth start metadata came through.
  //
  // Precedence: most-explicit cloud field first, then the original local
  // fields in their original order (`role` first, `requestedRole` last so a
  // stale earlier-step value can't override a later correction), then the
  // legacy `agentGoogleSide` as the final fallback.
  const raw = nonEmptyString(
    record.connectionRole ??
      record.role ??
      record.accountRole ??
      record.requestedRole ??
      record.agentGoogleSide
  );
  if (!raw) return "OWNER";
  const normalized = raw.toUpperCase();
  if (normalized === "OWNER" || normalized === "AGENT" || normalized === "TEAM") {
    return normalized;
  }
  return "OWNER";
}

function parseIdTokenClaims(idToken: string | undefined): GoogleIdentity {
  if (!idToken) return {};
  const segments = idToken.split(".");
  if (segments.length < 2) return {};
  try {
    const payload = Buffer.from(segments[1] ?? "", "base64url").toString("utf-8");
    const parsed = JSON.parse(payload) as GoogleIdentity;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function fetchGoogleUserInfoWithFetch(
  accessToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = GOOGLE_OAUTH_FETCH_TIMEOUT_MS,
  callerSignal?: AbortSignal
): Promise<GoogleIdentity> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(GOOGLE_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline,
  });
  if (!response.ok) {
    throw new Error(`Google userinfo request failed with ${response.status}`);
  }
  const parsed = (await response.json()) as GoogleIdentity;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Google userinfo returned an invalid payload.");
  }
  return parsed;
}

async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleIdentity> {
  return fetchGoogleUserInfoWithFetch(accessToken);
}

export async function exchangeAuthorizationCodeWithFetch(
  args: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    codeVerifier?: string;
  },
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = GOOGLE_OAUTH_FETCH_TIMEOUT_MS,
  callerSignal?: AbortSignal
): Promise<GoogleTokenResponse> {
  const params = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: "authorization_code",
    code: args.code,
  });
  if (args.codeVerifier) {
    params.set("code_verifier", args.codeVerifier);
  }

  const deadline = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(GOOGLE_OAUTH_PROVIDER_METADATA.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal: callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google token exchange failed with ${response.status}: ${body}`);
  }
  const parsed = (await response.json()) as GoogleTokenResponse;
  if (!parsed.access_token || !Number.isFinite(parsed.expires_in)) {
    throw new Error("Google token exchange returned an invalid payload.");
  }
  return parsed;
}

async function exchangeAuthorizationCode(args: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier?: string;
}): Promise<GoogleTokenResponse> {
  return exchangeAuthorizationCodeWithFetch(args);
}

/**
 * Build the Google ConnectorAccountManager provider. Exposes listAccounts (from
 * manager-owned storage), CRUD adapters, and a single consolidated PKCE OAuth
 * flow that returns a Google account hydrated with the granted capabilities,
 * scopes, and userinfo identity.
 */
export function createGoogleConnectorAccountProvider(
  runtime: IAgentRuntime
): ConnectorAccountProvider {
  return {
    provider: GOOGLE_SERVICE_NAME,
    label: GOOGLE_OAUTH_PROVIDER_METADATA.label,

    // Registering the provider also registers Gmail as a MESSAGE send
    // connector, so `op=send source=gmail` (aliases "email"/"mail") routes to
    // Gmail compose+send instead of SOURCE_CONNECTOR_NOT_FOUND.
    messageConnector: createGmailMessageConnector(runtime),

    listAccounts: async (manager: ConnectorAccountManager): Promise<ConnectorAccount[]> => {
      return manager.getStorage().listAccounts(GOOGLE_SERVICE_NAME);
    },

    createAccount: async (input: ConnectorAccountPatch, _manager: ConnectorAccountManager) => {
      // Persistence is owned by the manager; this adapter just normalizes the
      // patch into a Google-shaped account so role/purpose/status defaults are
      // sensible when an upstream caller creates the row before OAuth runs.
      return {
        ...input,
        provider: GOOGLE_SERVICE_NAME,
        role: input.role ?? "OWNER",
        purpose: input.purpose ?? ["messaging", "calendar", "drive", "meet"],
        accessGate: input.accessGate ?? "open",
        status: input.status ?? "pending",
      };
    },

    patchAccount: async (
      accountId: string,
      patch: ConnectorAccountPatch,
      _manager: ConnectorAccountManager
    ) => {
      if (patch.status === "revoked" || patch.status === "disabled") {
        const calendarService = runtime.getService("calendar");
        if (isGoogleCalendarWatchRevocationService(calendarService)) {
          await calendarService.revokeGoogleCalendarWatchesByAccount(accountId);
        }
      }
      return { ...patch, provider: GOOGLE_SERVICE_NAME };
    },

    deleteAccount: async (accountId: string, _manager: ConnectorAccountManager): Promise<void> => {
      const calendarService = runtime.getService("calendar");
      if (isGoogleCalendarWatchRevocationService(calendarService)) {
        await calendarService.revokeGoogleCalendarWatchesByAccount(accountId);
      }
      // Credential cleanup is the credential store's responsibility; the
      // manager removes the account row after this resolves.
    },

    startOAuth: async (
      request: ConnectorOAuthStartRequest,
      manager: ConnectorAccountManager
    ): Promise<ConnectorOAuthStartResult> => {
      // The manager forwards the served origin captured at the HTTP boundary
      // (Settings route) or by LifeOps; callback validation runs against it so
      // an unreachable callback fails here instead of stranding the grant.
      const config = readClientConfig(runtime, request.servedOrigin);
      const redirectUri = config.redirectUri;
      const capabilities = normalizeRequestedCapabilities(
        await resolveRequestedScopes(request, manager)
      );
      const oauthScopes = scopesForGoogleCapabilities(capabilities);
      const codeVerifier = createCodeVerifier();
      const codeChallenge = createCodeChallenge(codeVerifier);

      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: oauthScopes.join(" "),
        state: request.flow.state,
        access_type: "offline",
        prompt: "consent",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        include_granted_scopes: "false",
      });

      return {
        authUrl: `${GOOGLE_OAUTH_PROVIDER_METADATA.authorizationEndpoint}?${params.toString()}`,
        // Provider-owned canonical callback: the manager persists
        // result.redirectUri ?? flow.redirectUri, so returning it keeps the
        // stored flow callback populated when the caller supplies none.
        redirectUri,
        codeVerifier,
        metadata: {
          ...request.metadata,
          requestedCapabilities: capabilities,
          requestedScopes: oauthScopes,
          redirectUri,
        },
      };
    },

    completeOAuth: async (
      request: ConnectorOAuthCallbackRequest,
      manager: ConnectorAccountManager
    ): Promise<ConnectorOAuthCallbackResult> => {
      const code = nonEmptyString(request.code);
      if (!code) {
        throw new Error("Google OAuth callback is missing an authorization code.");
      }

      const config = readClientConfig(runtime);
      const redirectUri =
        nonEmptyString(request.flow.redirectUri) ??
        nonEmptyString(
          (request.flow.metadata as Record<string, unknown> | undefined)?.redirectUri
        ) ??
        config.redirectUri;

      const tokens = await exchangeAuthorizationCode({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri,
        code,
        codeVerifier: request.flow.codeVerifier,
      });

      const grantedScopes = parseScopeString(tokens.scope);
      const normalizedGrant =
        grantedScopes.length > 0
          ? normalizeGrantedCapabilities(grantedScopes)
          : {
              capabilities: normalizeRequestedCapabilities(
                requestedScopesFromMetadata(request.flow.metadata)
              ),
              ignoredScopes: [],
            };
      const grantedCapabilities = normalizedGrant.capabilities;
      if (normalizedGrant.ignoredScopes.length > 0) {
        logger.warn(
          {
            src: "plugin:google:oauth",
            ignoredScopes: normalizedGrant.ignoredScopes,
          },
          "[GoogleConnectorAccountProvider] Ignoring unmapped scopes returned by Google"
        );
      }
      if (grantedCapabilities.length === 0) {
        throw new ElizaError(
          "Google OAuth completed without a usable Gmail, Calendar, Drive, or Meet capability.",
          {
            code: "GOOGLE_OAUTH_CAPABILITY_NOT_GRANTED",
            context: {
              grantedScopes,
              ignoredScopes: normalizedGrant.ignoredScopes,
            },
            severity: "fatal",
          }
        );
      }
      const purposes = purposesForCapabilities(grantedCapabilities);

      let identity = parseIdTokenClaims(tokens.id_token);
      if (!identity.email) {
        identity = { ...identity, ...(await fetchGoogleUserInfo(tokens.access_token)) };
      }

      const externalId = nonEmptyString(identity.sub) ?? nonEmptyString(identity.email);
      if (!externalId) {
        throw new Error("Google identity payload did not include sub or email.");
      }
      const expiresAt = Date.now() + tokens.expires_in * 1000;
      const oauthCredentialVersion = String(Date.now());
      const accountMetadata = {
        email: identity.email ?? null,
        emailVerified: identity.email_verified ?? null,
        name: identity.name ?? null,
        picture: identity.picture ?? null,
        locale: identity.locale ?? null,
        grantedCapabilities,
        grantedScopes:
          grantedScopes.length > 0
            ? grantedScopes
            : scopesForGoogleCapabilities(grantedCapabilities),
        identityScopes: [...GOOGLE_IDENTITY_SCOPES],
        tokenType: tokens.token_type ?? "Bearer",
        hasRefreshToken: Boolean(tokens.refresh_token),
        expiresAt,
        oauthCredentialVersion,
      };
      const pendingAccount = await manager.upsertAccount(
        GOOGLE_SERVICE_NAME,
        {
          provider: GOOGLE_SERVICE_NAME,
          role: roleFromMetadata(request.flow.metadata),
          purpose: purposes,
          accessGate: "open",
          status: "pending",
          externalId,
          displayHandle: nonEmptyString(identity.email) ?? nonEmptyString(identity.name),
          label:
            nonEmptyString(identity.name) ??
            nonEmptyString(identity.email) ??
            GOOGLE_OAUTH_PROVIDER_METADATA.label,
          metadata: accountMetadata,
        },
        request.flow.accountId
      );
      const credentialPersist = await persistConnectorCredentialRefs({
        runtime,
        manager,
        provider: GOOGLE_SERVICE_NAME,
        accountIdForRef: pendingAccount.id,
        storageAccountId: pendingAccount.id,
        caller: "plugin-google-workspace",
        credentials: [
          {
            credentialType: "oauth.tokens",
            value: JSON.stringify({
              access_token: tokens.access_token,
              ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
              ...(tokens.id_token ? { id_token: tokens.id_token } : {}),
              token_type: tokens.token_type ?? "Bearer",
              scope:
                grantedScopes.length > 0
                  ? grantedScopes.join(" ")
                  : scopesForGoogleCapabilities(grantedCapabilities).join(" "),
              expiry_date: expiresAt,
            }),
            expiresAt,
            metadata: {
              provider: GOOGLE_SERVICE_NAME,
              hasRefreshToken: Boolean(tokens.refresh_token),
            },
          },
        ],
      });

      const accountPatch: ConnectorAccountPatch & {
        provider: string;
        id: string;
      } = {
        ...pendingAccount,
        id: pendingAccount.id,
        provider: GOOGLE_SERVICE_NAME,
        status: "connected",
        metadata: {
          ...accountMetadata,
          credentialRefs: credentialPersist.refs,
          credentialRefStorage: {
            vaultAvailable: credentialPersist.vaultAvailable,
            storageAvailable: credentialPersist.storageAvailable,
          },
        },
      };

      logger.info(
        {
          src: "plugin:google:connector",
          externalId,
          capabilities: grantedCapabilities,
        },
        "Google OAuth completed"
      );

      return {
        account: accountPatch,
        flow: { status: "completed" },
      };
    },
  };
}
