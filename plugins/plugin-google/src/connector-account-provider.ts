/**
 * Google ConnectorAccountManager provider.
 *
 * Bridges plugin-google to the @elizaos/core ConnectorAccountManager so the
 * generic HTTP CRUD + OAuth surface (packages/agent/src/api/connector-account-routes.ts)
 * can list, create, patch, delete, and run the OAuth flow for Google accounts
 * using a single consolidated grant covering Gmail, Calendar, Drive, and Meet.
 *
 * Single OAuth grant per account: callers may pass `scopes` to the manager's
 * startOAuth to limit which capabilities are requested. By default all
 * capabilities (gmail.read+send+manage, calendar.read+write, drive.read+write,
 * meet.create+read) are requested; granted capabilities are recorded on the
 * returned account so downstream consumers know which surfaces are usable.
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
  type IAgentRuntime,
  logger,
} from "@elizaos/core";
import { GOOGLE_OAUTH_PROVIDER_METADATA } from "./auth.js";
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

const GROUP_PURPOSE: Record<GoogleCapabilityGroup, ConnectorAccountPurpose> = {
  gmail: "messaging" as ConnectorAccountPurpose,
  calendar: "calendar" as ConnectorAccountPurpose,
  drive: "drive" as ConnectorAccountPurpose,
  meet: "meet" as ConnectorAccountPurpose,
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

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
  return nonEmptyString(runtime.getSetting?.(key));
}

function readClientConfig(runtime: IAgentRuntime): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const clientId = readSetting(runtime, "GOOGLE_CLIENT_ID");
  const clientSecret = readSetting(runtime, "GOOGLE_CLIENT_SECRET");
  const redirectUri = readSetting(runtime, "GOOGLE_REDIRECT_URI");
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Google OAuth requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI to be configured."
    );
  }
  return { clientId, clientSecret, redirectUri };
}

function normalizeRequestedCapabilities(scopes: readonly string[] | undefined): GoogleCapability[] {
  if (!scopes || scopes.length === 0) {
    return [...GOOGLE_CAPABILITIES];
  }
  // The caller passes either capability identifiers (e.g. "gmail.read") OR raw
  // OAuth scope URLs. Both shapes are accepted so the manager's startOAuth API
  // surface stays uniform with other providers (which use raw scopes).
  const requested = new Set<GoogleCapability>();
  for (const value of scopes) {
    if (isGoogleCapability(value)) {
      requested.add(value);
      continue;
    }
    const matched = matchCapabilityFromScope(value);
    if (matched) {
      requested.add(matched);
    }
  }
  if (requested.size === 0) {
    return [...GOOGLE_CAPABILITIES];
  }
  return [...requested];
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

function parseScopeString(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
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
        role: input.role ?? "OWNER",
        purpose: input.purpose ?? ["messaging", "calendar", "drive", "meet"],
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

    deleteAccount: async (_accountId: string, _manager: ConnectorAccountManager): Promise<void> => {
      // Credential cleanup is the credential store's responsibility; the
      // manager removes the account row after this resolves.
    },

    startOAuth: async (
      request: ConnectorOAuthStartRequest,
      _manager: ConnectorAccountManager
    ): Promise<ConnectorOAuthStartResult> => {
      const config = readClientConfig(runtime);
      const redirectUri = request.redirectUri ?? config.redirectUri;
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
      _manager: ConnectorAccountManager
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
      const grantedCapabilities = normalizeRequestedCapabilities(
        grantedScopes.length > 0
          ? grantedScopes
          : ((request.flow.metadata as Record<string, unknown> | undefined)?.requestedScopes as
              | string[]
              | undefined)
      );
      const purposes = purposesForCapabilities(grantedCapabilities);

      let identity = parseIdTokenClaims(tokens.id_token);
      if (!identity.email) {
        identity = { ...identity, ...(await fetchGoogleUserInfo(tokens.access_token)) };
      }

      const externalId = nonEmptyString(identity.sub) ?? nonEmptyString(identity.email);
      if (!externalId) {
        throw new Error("Google identity payload did not include sub or email.");
      }

      const accountPatch: ConnectorAccountPatch & {
        provider: string;
      } = {
        provider: GOOGLE_SERVICE_NAME,
        role: "OWNER",
        purpose: purposes,
        accessGate: "open",
        status: "connected",
        externalId,
        displayHandle: nonEmptyString(identity.email) ?? nonEmptyString(identity.name),
        label:
          nonEmptyString(identity.name) ??
          nonEmptyString(identity.email) ??
          GOOGLE_OAUTH_PROVIDER_METADATA.label,
        metadata: {
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
          expiresAt: Date.now() + tokens.expires_in * 1000,
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
