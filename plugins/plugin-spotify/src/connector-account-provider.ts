/**
 * Spotify ConnectorAccountManager provider: the managed-OAuth side of the
 * plugin. `startOAuth` builds a PKCE authorization URL against the runtime's
 * configured Spotify app; `completeOAuth` exchanges the code, resolves the
 * account identity (including the free/premium `product` tier so playback
 * actions can explain a 403 before it happens), persists tokens behind vault
 * refs, and returns the connected account patch. Delete/revoke drops the
 * service's cached tokens so a disconnected account cannot keep acting.
 *
 * Raw tokens never land in account metadata — only vault refs do — so account
 * listings, logs, and model context stay credential-free.
 */
import {
  type ConnectorAccountManager,
  type ConnectorAccountPatch,
  type ConnectorAccountProvider,
  type ConnectorOAuthCallbackRequest,
  type ConnectorOAuthCallbackResult,
  type ConnectorOAuthStartRequest,
  type ConnectorOAuthStartResult,
  ElizaError,
  type IAgentRuntime,
  logger,
} from "@elizaos/core";
import {
  createCodeChallenge,
  createCodeVerifier,
  exchangeAuthorizationCode,
  SPOTIFY_AUTHORIZE_ENDPOINT,
  SPOTIFY_OAUTH_SCOPES,
} from "./auth";
import { SpotifyApiClient } from "./client";
import { persistSpotifyCredentialRefs } from "./credential-refs";
import type { SpotifyService } from "./service";
import { SPOTIFY_SERVICE_NAME } from "./types";

export const SPOTIFY_PROVIDER_ID = SPOTIFY_SERVICE_NAME;

export interface SpotifyConnectorProviderOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readClientConfig(
  runtime: IAgentRuntime,
  servedOrigin?: string
): { clientId: string; clientSecret?: string; redirectUri: string } {
  const clientId = nonEmptyString(runtime.getSetting?.("SPOTIFY_CLIENT_ID"));
  const clientSecret = nonEmptyString(runtime.getSetting?.("SPOTIFY_CLIENT_SECRET"));
  const configured = nonEmptyString(runtime.getSetting?.("SPOTIFY_REDIRECT_URI"));
  const redirectUri =
    configured ??
    (servedOrigin
      ? `${servedOrigin.replace(/\/$/, "")}/api/connector-accounts/${SPOTIFY_PROVIDER_ID}/oauth/callback`
      : undefined);
  if (!clientId || !redirectUri) {
    throw new ElizaError(
      "Spotify OAuth requires SPOTIFY_CLIENT_ID and SPOTIFY_REDIRECT_URI (or a served origin) to be configured.",
      {
        code: "SPOTIFY_CONFIG_MISSING",
        context: { hasClientId: Boolean(clientId), hasRedirectUri: Boolean(redirectUri) },
        severity: "fatal",
      }
    );
  }
  return { clientId, ...(clientSecret ? { clientSecret } : {}), redirectUri };
}

/**
 * Requested scopes default to the full consolidated grant; an explicit list
 * narrows it but never silently expands beyond the known catalog.
 */
function normalizeRequestedScopes(scopes: readonly string[] | undefined): string[] {
  if (scopes === undefined || scopes.length === 0) {
    return [...SPOTIFY_OAUTH_SCOPES];
  }
  const known = new Set<string>(SPOTIFY_OAUTH_SCOPES);
  const requested: string[] = [];
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (!trimmed) continue;
    if (!known.has(trimmed)) {
      throw new ElizaError(`Spotify OAuth scope is not recognized: ${trimmed}`, {
        code: "SPOTIFY_INVALID_INPUT",
        context: { scope: trimmed },
        severity: "fatal",
      });
    }
    requested.push(trimmed);
  }
  if (requested.length === 0) {
    throw new ElizaError("Spotify OAuth requires at least one recognized scope.", {
      code: "SPOTIFY_INVALID_INPUT",
      context: { scopes: [...scopes] },
      severity: "fatal",
    });
  }
  return requested;
}

export function createSpotifyConnectorAccountProvider(
  runtime: IAgentRuntime,
  options: SpotifyConnectorProviderOptions = {}
): ConnectorAccountProvider {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const invalidateServiceAccount = (accountId: string): void => {
    const service = runtime.getService?.(SPOTIFY_SERVICE_NAME) as SpotifyService | null;
    service?.invalidateAccount?.(accountId);
  };

  return {
    provider: SPOTIFY_PROVIDER_ID,
    label: "Spotify",

    listAccounts: async (manager: ConnectorAccountManager) => {
      return manager.getStorage().listAccounts(SPOTIFY_PROVIDER_ID);
    },

    createAccount: async (input: ConnectorAccountPatch, _manager: ConnectorAccountManager) => {
      return {
        ...input,
        provider: SPOTIFY_PROVIDER_ID,
        role: input.role ?? "OWNER",
        purpose: input.purpose ?? ["media"],
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
        invalidateServiceAccount(accountId);
      }
      return { ...patch, provider: SPOTIFY_PROVIDER_ID };
    },

    deleteAccount: async (accountId: string, _manager: ConnectorAccountManager) => {
      invalidateServiceAccount(accountId);
      // Vaulted credentials are keyed by account id; the credential store owns
      // cleanup. The manager removes the account row after this resolves.
    },

    startOAuth: async (
      request: ConnectorOAuthStartRequest,
      _manager: ConnectorAccountManager
    ): Promise<ConnectorOAuthStartResult> => {
      const config = readClientConfig(runtime, request.servedOrigin);
      const scopes = normalizeRequestedScopes(request.scopes);
      const codeVerifier = createCodeVerifier();
      const codeChallenge = createCodeChallenge(codeVerifier);
      const params = new URLSearchParams({
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: config.redirectUri,
        state: request.flow.state,
        scope: scopes.join(" "),
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        show_dialog: "false",
      });
      return {
        authUrl: `${SPOTIFY_AUTHORIZE_ENDPOINT}?${params.toString()}`,
        redirectUri: config.redirectUri,
        codeVerifier,
        metadata: {
          ...request.metadata,
          requestedScopes: scopes,
          redirectUri: config.redirectUri,
        },
      };
    },

    completeOAuth: async (
      request: ConnectorOAuthCallbackRequest,
      manager: ConnectorAccountManager
    ): Promise<ConnectorOAuthCallbackResult> => {
      if (request.error) {
        throw new ElizaError(`Spotify OAuth was denied: ${request.error}`, {
          code: "SPOTIFY_AUTH_REQUIRED",
          context: { error: request.error, description: request.errorDescription ?? null },
          severity: "fatal",
        });
      }
      const code = nonEmptyString(request.code);
      if (!code) {
        throw new ElizaError("Spotify OAuth callback is missing an authorization code.", {
          code: "SPOTIFY_AUTH_REQUIRED",
          severity: "fatal",
        });
      }
      const config = readClientConfig(runtime);
      const redirectUri =
        nonEmptyString(request.flow.redirectUri) ??
        nonEmptyString(
          (request.flow.metadata as Record<string, unknown> | undefined)?.redirectUri
        ) ??
        config.redirectUri;

      const tokens = await exchangeAuthorizationCode(
        {
          clientId: config.clientId,
          ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
          redirectUri,
          code,
          ...(request.flow.codeVerifier ? { codeVerifier: request.flow.codeVerifier } : {}),
        },
        fetchImpl
      );

      const identityClient = new SpotifyApiClient({
        getAccessToken: async () => tokens.accessToken,
        fetchImpl,
        ...(options.apiBase !== undefined ? { apiBase: options.apiBase } : {}),
      });
      const profile = await identityClient.getProfile();

      const grantedScopes = tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : [];
      const accountMetadata = {
        displayName: profile.displayName,
        email: profile.email,
        product: profile.product,
        country: profile.country,
        grantedScopes,
        hasRefreshToken: Boolean(tokens.refreshToken),
        expiresAt: tokens.expiresAt,
      };
      const pendingAccount = await manager.upsertAccount(
        SPOTIFY_PROVIDER_ID,
        {
          provider: SPOTIFY_PROVIDER_ID,
          role: "OWNER",
          purpose: ["media"],
          accessGate: "open",
          status: "pending",
          externalId: profile.id,
          displayHandle: profile.displayName ?? profile.id,
          label: profile.displayName ?? profile.id,
          metadata: accountMetadata,
        },
        request.flow.accountId ?? `acct_spotify_${profile.id}`
      );
      const persisted = await persistSpotifyCredentialRefs({
        runtime,
        manager,
        provider: SPOTIFY_PROVIDER_ID,
        accountId: pendingAccount.id,
        caller: "plugin-spotify",
        credentials: [
          {
            credentialType: "oauth.tokens",
            value: JSON.stringify({
              access_token: tokens.accessToken,
              ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
              expiry_date: tokens.expiresAt,
              scope: tokens.scope,
            }),
            expiresAt: tokens.expiresAt,
            metadata: {
              provider: SPOTIFY_PROVIDER_ID,
              hasRefreshToken: Boolean(tokens.refreshToken),
            },
          },
        ],
      });

      logger.info(
        { src: "plugin:spotify:connector", externalId: profile.id, product: profile.product },
        "Spotify OAuth completed"
      );

      return {
        account: {
          ...pendingAccount,
          id: pendingAccount.id,
          provider: SPOTIFY_PROVIDER_ID,
          status: "connected",
          metadata: {
            ...accountMetadata,
            credentialRefs: persisted.refs,
          },
        },
        flow: { status: "completed" },
      };
    },
  };
}
