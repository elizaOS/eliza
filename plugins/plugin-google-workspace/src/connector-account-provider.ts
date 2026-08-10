/**
 * Google ConnectorAccountManager provider.
 *
 * Bridges plugin-google-workspace to the @elizaos/core ConnectorAccountManager so the
 * generic HTTP CRUD + OAuth surface (packages/agent/src/api/connector-account-routes.ts)
 * can list, create, patch, delete, and run the OAuth flow for Google accounts
 * using one direct OAuth grant covering the selected personal Workspace MCP
 * products.
 *
 * Single OAuth grant per account: callers may pass `scopes` to the manager's
 * startOAuth to limit which capabilities are requested. By default all
 * capabilities are requested; granted capabilities are recorded on the
 * returned account so downstream consumers know which MCP resources are usable.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  type ConnectorAccount,
  type ConnectorAccountManager,
  type ConnectorAccountPatch,
  type ConnectorAccountProvider,
  type ConnectorAccountPurpose,
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
import { DefaultGoogleCredentialResolver } from "./credential-resolver.js";
import {
  GOOGLE_CAPABILITIES,
  GOOGLE_CAPABILITY_AUTHORIZATION_SCOPES,
  GOOGLE_IDENTITY_SCOPES,
  type GoogleCapability,
  type GoogleCapabilityGroup,
  isGoogleCapability,
  scopesForGoogleCapabilities,
} from "./scopes.js";
import { GOOGLE_SERVICE_NAME } from "./types.js";

const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

const GROUP_PURPOSE: Record<GoogleCapabilityGroup, ConnectorAccountPurpose> = {
  gmail: "messaging" as ConnectorAccountPurpose,
  calendar: "calendar" as ConnectorAccountPurpose,
  drive: "drive" as ConnectorAccountPurpose,
  docs: "documents" as ConnectorAccountPurpose,
  sheets: "documents" as ConnectorAccountPurpose,
  slides: "documents" as ConnectorAccountPurpose,
  chat: "messaging" as ConnectorAccountPurpose,
  people: "reading" as ConnectorAccountPurpose,
  workspace: "reading" as ConnectorAccountPurpose,
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

interface GoogleMcpAccountLifecycleService {
  connectMcpAccount(account: ConnectorAccount): Promise<unknown>;
  disconnectMcpAccount(accountId: string): Promise<void>;
}

function isGoogleMcpAccountLifecycleService(
  value: unknown
): value is GoogleMcpAccountLifecycleService {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Partial<GoogleMcpAccountLifecycleService>).connectMcpAccount === "function" &&
    typeof (value as Partial<GoogleMcpAccountLifecycleService>).disconnectMcpAccount === "function"
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

interface GoogleSecretsService {
  getGlobal(key: string): Promise<string | null>;
  setGlobal?(key: string, value: string): Promise<boolean>;
}

function googleSecretsService(runtime: IAgentRuntime): GoogleSecretsService | null {
  const service = runtime.getService("SECRETS") as Partial<GoogleSecretsService> | null;
  return service && typeof service.getGlobal === "function"
    ? (service as GoogleSecretsService)
    : null;
}

async function readClientRegistration(runtime: IAgentRuntime): Promise<{
  clientId: string;
  clientSecret: string;
}> {
  const secrets = googleSecretsService(runtime);
  let clientId = nonEmptyString(await secrets?.getGlobal("GOOGLE_CLIENT_ID"));
  let clientSecret = nonEmptyString(await secrets?.getGlobal("GOOGLE_CLIENT_SECRET"));
  if (!clientId || !clientSecret) {
    const configuredClientId = readSetting(runtime, "GOOGLE_CLIENT_ID");
    const configuredSecret = readSetting(runtime, "GOOGLE_CLIENT_SECRET");
    const allowMigration = readSetting(runtime, "GOOGLE_OAUTH_VAULT_MIGRATE_FROM_ENV") === "1";
    if (allowMigration && secrets?.setGlobal) {
      if (!clientId && configuredClientId) {
        await secrets.setGlobal("GOOGLE_CLIENT_ID", configuredClientId);
        clientId = nonEmptyString(await secrets.getGlobal("GOOGLE_CLIENT_ID"));
      }
      if (!clientSecret && configuredSecret) {
        await secrets.setGlobal("GOOGLE_CLIENT_SECRET", configuredSecret);
        clientSecret = nonEmptyString(await secrets.getGlobal("GOOGLE_CLIENT_SECRET"));
      }
    }
  }
  if (!clientId || !clientSecret) {
    throw new Error(
      "Google OAuth requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the vault."
    );
  }
  return { clientId, clientSecret };
}

function normalizeRequestedCapabilities(scopes: readonly string[] | undefined): GoogleCapability[] {
  if (!scopes || scopes.length === 0) {
    return [...GOOGLE_CAPABILITIES];
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
    const matched = capabilitiesFromScope(value);
    if (matched.length > 0) {
      for (const capability of matched) requested.add(capability);
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
    throw new ElizaError("Google OAuth requires at least one supported Workspace MCP capability.", {
      code: "GOOGLE_OAUTH_CAPABILITY_REQUIRED",
      context: { scopes: [...scopes] },
      severity: "fatal",
    });
  }
  return [...requested];
}

function normalizeGrantedCapabilities(scopes: readonly string[]): {
  capabilities: GoogleCapability[];
  ignoredScopes: string[];
} {
  const capabilities = new Set<GoogleCapability>();
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
    const matched = capabilitiesFromScope(normalized);
    if (matched.length > 0) {
      for (const capability of matched) capabilities.add(capability);
      continue;
    }
    if (!identityScopes.has(normalized.toLowerCase())) {
      ignoredScopes.push(normalized);
    }
  }

  return { capabilities: [...capabilities], ignoredScopes };
}

function capabilitiesFromScope(scope: string): GoogleCapability[] {
  // Provider-returned legacy grants may authorize a read capability even when
  // the least-privilege request catalog would never ask for that broad scope.
  const trimmed = scope.trim().toLowerCase();
  return GOOGLE_CAPABILITIES.filter((capability) =>
    GOOGLE_CAPABILITY_AUTHORIZATION_SCOPES[capability].some(
      (value) => value.toLowerCase() === trimmed
    )
  );
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

function requestedCapabilitiesFromMetadata(metadata: unknown): GoogleCapability[] {
  if (!isRecord(metadata) || metadata.requestedCapabilities === undefined) {
    throw new ElizaError(
      "Google OAuth callback is missing the capabilities bound to the authorization request.",
      {
        code: "GOOGLE_OAUTH_REQUESTED_CAPABILITIES_MISSING",
        severity: "fatal",
      }
    );
  }
  const capabilities = metadata.requestedCapabilities;
  if (
    !Array.isArray(capabilities) ||
    capabilities.some((capability) => typeof capability !== "string")
  ) {
    throw new ElizaError("Google OAuth callback contains invalid capability metadata.", {
      code: "GOOGLE_OAUTH_REQUESTED_CAPABILITIES_INVALID",
      context: {
        valueType: Array.isArray(capabilities) ? "array-with-non-string" : typeof capabilities,
      },
      severity: "fatal",
    });
  }
  return normalizeRequestedCapabilities(capabilities);
}

export function selectRequestedGrantedCapabilities(
  requestedCapabilities: readonly GoogleCapability[],
  grantedCapabilities: readonly GoogleCapability[]
): GoogleCapability[] {
  const granted = new Set(grantedCapabilities);
  return requestedCapabilities.filter((capability) => granted.has(capability));
}

export async function revokeGoogleOAuthToken(token: string): Promise<void> {
  const response = await fetch(GOOGLE_OAUTH_PROVIDER_METADATA.revokeEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
  if (!response.ok) {
    throw new ElizaError("Google rejected the OAuth token revocation request.", {
      code: "GOOGLE_OAUTH_REVOKE_FAILED",
      context: { status: response.status },
      severity: "fatal",
    });
  }
}

function isDefaultFromMetadata(metadata: unknown): boolean {
  return isRecord(metadata) && metadata.isDefault === true;
}

function productsForCapabilities(capabilities: readonly GoogleCapability[]): string[] {
  return [...new Set(capabilities.map((capability) => capability.split(".")[0]))];
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

async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleIdentity> {
  const response = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
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

async function exchangeAuthorizationCode(args: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier?: string;
}): Promise<GoogleTokenResponse> {
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

  const response = await fetch(GOOGLE_OAUTH_PROVIDER_METADATA.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
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
        role: "OWNER",
        purpose: input.purpose ?? ["messaging", "calendar", "drive", "documents", "reading"],
        accessGate: input.accessGate ?? "open",
        status: input.status ?? "pending",
      };
    },

    patchAccount: async (
      _accountId: string,
      patch: ConnectorAccountPatch,
      _manager: ConnectorAccountManager
    ) => {
      return { ...patch, provider: GOOGLE_SERVICE_NAME };
    },

    deleteAccount: async (accountId: string, manager: ConnectorAccountManager): Promise<void> => {
      const account = await manager.getAccount(GOOGLE_SERVICE_NAME, accountId);
      if (!account) return;
      const authClient = await new DefaultGoogleCredentialResolver({
        runtime,
        accountManager: manager,
      }).getAuthClient({
        provider: GOOGLE_SERVICE_NAME,
        accountId,
        scopes: account.scopes ?? [],
        capabilities: (account.capabilities ?? []).filter(isGoogleCapability),
        reason: "revoke personal Google OAuth grant",
      });
      const token = authClient.credentials.refresh_token ?? authClient.credentials.access_token;
      if (!token) {
        throw new ElizaError("Google OAuth account has no token available for revocation.", {
          code: "GOOGLE_OAUTH_REVOKE_TOKEN_MISSING",
          context: { accountId },
          severity: "fatal",
        });
      }
      const workspaceService = runtime.getService(GOOGLE_SERVICE_NAME);
      if (isGoogleMcpAccountLifecycleService(workspaceService)) {
        await workspaceService.disconnectMcpAccount(accountId);
      }
      try {
        await revokeGoogleOAuthToken(token);
      } catch (cause) {
        if (isGoogleMcpAccountLifecycleService(workspaceService)) {
          try {
            await workspaceService.connectMcpAccount(account);
          } catch (restoreError) {
            // error-policy:J7 revocation remains the surfaced failure; a failed
            // exposure restore is separately reported to the runtime owner.
            runtime.reportError("google.oauth.revoke.restore", restoreError, { accountId });
          }
        }
        // error-policy:J2 the account and vault refs remain intact so the user
        // can retry; preserve the provider failure without reporting success.
        throw new ElizaError("Could not revoke the personal Google OAuth grant.", {
          code: "GOOGLE_OAUTH_REVOKE_FAILED",
          context: { accountId },
          cause,
          severity: "fatal",
        });
      }
      // The manager removes vault values, credential refs, and the account row
      // only after upstream revocation and MCP detachment both succeed.
    },

    startOAuth: async (
      request: ConnectorOAuthStartRequest,
      _manager: ConnectorAccountManager
    ): Promise<ConnectorOAuthStartResult> => {
      const config = await readClientRegistration(runtime);
      const redirectUri = nonEmptyString(request.redirectUri);
      if (!redirectUri) {
        throw new Error("Google OAuth start requires a request-derived callback URI.");
      }
      const capabilities = normalizeRequestedCapabilities(request.scopes);
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
        include_granted_scopes: "true",
      });

      return {
        authUrl: `${GOOGLE_OAUTH_PROVIDER_METADATA.authorizationEndpoint}?${params.toString()}`,
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

      const config = await readClientRegistration(runtime);
      const redirectUri =
        nonEmptyString(request.flow.redirectUri) ??
        nonEmptyString((request.flow.metadata as Record<string, unknown> | undefined)?.redirectUri);
      if (!redirectUri) {
        throw new Error("Google OAuth callback is missing its original redirect URI.");
      }

      const tokens = await exchangeAuthorizationCode({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri,
        code,
        codeVerifier: request.flow.codeVerifier,
      });

      const grantedScopes = parseScopeString(tokens.scope);
      const requestedCapabilities = requestedCapabilitiesFromMetadata(request.flow.metadata);
      const normalizedGrant =
        grantedScopes.length > 0
          ? normalizeGrantedCapabilities(grantedScopes)
          : {
              capabilities: requestedCapabilities,
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
        throw new ElizaError("Google OAuth completed without a usable Workspace MCP capability.", {
          code: "GOOGLE_OAUTH_CAPABILITY_NOT_GRANTED",
          context: {
            grantedScopes,
            ignoredScopes: normalizedGrant.ignoredScopes,
          },
          severity: "fatal",
        });
      }
      const selectedCapabilities = selectRequestedGrantedCapabilities(
        requestedCapabilities,
        grantedCapabilities
      );
      if (selectedCapabilities.length === 0) {
        throw new ElizaError(
          "Google OAuth did not grant any of the Workspace MCP capabilities selected for this connection.",
          {
            code: "GOOGLE_OAUTH_SELECTED_CAPABILITY_NOT_GRANTED",
            context: { requestedCapabilities, grantedCapabilities },
            severity: "fatal",
          }
        );
      }
      const purposes = purposesForCapabilities(selectedCapabilities);
      const effectiveGrantedScopes =
        grantedScopes.length > 0 ? grantedScopes : scopesForGoogleCapabilities(grantedCapabilities);

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
        selectedCapabilities,
        grantedScopes: effectiveGrantedScopes,
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
          role: "OWNER",
          purpose: purposes,
          accessGate: "open",
          status: "pending",
          scopes: effectiveGrantedScopes,
          capabilities: selectedCapabilities,
          selectedProducts: productsForCapabilities(selectedCapabilities),
          isDefault: isDefaultFromMetadata(request.flow.metadata),
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
      await persistConnectorCredentialRefs({
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
        },
      };

      logger.info(
        {
          src: "plugin:google:connector",
          externalId,
          grantedCapabilities,
          selectedCapabilities,
        },
        "Google OAuth completed"
      );

      return {
        account: accountPatch,
        flow: { status: "completed" },
      };
    },

    afterAccountUpsert: async (account) => {
      const workspaceService = runtime.getService(GOOGLE_SERVICE_NAME);
      if (!isGoogleMcpAccountLifecycleService(workspaceService)) return;
      if (account.status === "connected") {
        await workspaceService.connectMcpAccount(account);
      } else {
        await workspaceService.disconnectMcpAccount(account.id);
      }
    },
  };
}
