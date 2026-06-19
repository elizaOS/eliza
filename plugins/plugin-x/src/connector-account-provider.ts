/**
 * X (Twitter) ConnectorAccountManager provider.
 *
 * Bridges plugin-x to the @elizaos/core ConnectorAccountManager so the generic
 * HTTP CRUD + OAuth surface can list, create, patch, delete, and run the
 * Twitter OAuth2 PKCE flow for X accounts.
 *
 * The X plugin runs in two complementary modes:
 *
 *  - **env**: a single OAuth1 application credential set lives in
 *    runtime settings (TWITTER_API_KEY/SECRET/ACCESS_TOKEN/SECRET). At plugin
 *    start we materialize a synthetic `default` account so the rest of the
 *    runtime can address it through the connector account interface.
 *
 *  - **oauth (PKCE)**: per-user OAuth2 PKCE flow against
 *    `https://twitter.com/i/oauth2/authorize`. Tokens are persisted via the
 *    plugin's TokenStore and the resulting account is keyed by the X user id
 *    returned from `users/me`.
 */

import {
  type ConnectorAccount,
  type ConnectorAccountManager,
  type ConnectorAccountPatch,
  type ConnectorAccountProvider,
  type ConnectorAccountRole,
  type ConnectorOAuthCallbackRequest,
  type ConnectorOAuthCallbackResult,
  type ConnectorOAuthStartRequest,
  type ConnectorOAuthStartResult,
  getConnectorAccountManager,
  type IAgentRuntime,
  logger,
} from "@elizaos/core";
import {
  createCodeChallenge,
  createCodeVerifier,
} from "./client/auth-providers/pkce";
import { persistConnectorCredentialRefs } from "./connector-credential-refs";
import { getSetting } from "./utils/settings";

const TWITTER_AUTHORIZE_URL = "https://twitter.com/i/oauth2/authorize";
const TWITTER_TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const TWITTER_USERS_ME_URL =
  "https://api.twitter.com/2/users/me?user.fields=id,name,username";

const DEFAULT_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "offline.access",
];

const DEFAULT_PURPOSES = ["posting", "reading", "messaging"] as const;

const X_PROVIDER = "x" as const;
const DEFAULT_ACCOUNT_ID = "default" as const;
const ENV_ACCOUNT_LABEL = "Imported from environment";

interface TwitterTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

interface TwitterUserMeResponse {
  data?: {
    id?: string;
    username?: string;
    name?: string;
  };
}

function readScopes(runtime: IAgentRuntime, override?: string[]): string[] {
  if (override && override.length > 0) {
    return override;
  }
  const raw = getSetting(runtime, "TWITTER_SCOPES");
  if (raw?.trim()) {
    return raw
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
  }
  return [...DEFAULT_SCOPES];
}

function readClientConfig(runtime: IAgentRuntime): {
  clientId: string;
  redirectUri: string;
} {
  const clientId = getSetting(runtime, "TWITTER_CLIENT_ID");
  const redirectUri = getSetting(runtime, "TWITTER_REDIRECT_URI");
  if (!clientId || !redirectUri) {
    throw new Error(
      "X OAuth requires TWITTER_CLIENT_ID and TWITTER_REDIRECT_URI to be configured.",
    );
  }
  return { clientId, redirectUri };
}

function readEnvCredentials(runtime: IAgentRuntime): {
  apiKey: string;
  apiSecretKey: string;
  accessToken: string;
  accessTokenSecret: string;
} | null {
  const apiKey = getSetting(runtime, "TWITTER_API_KEY");
  const apiSecretKey = getSetting(runtime, "TWITTER_API_SECRET_KEY");
  const accessToken = getSetting(runtime, "TWITTER_ACCESS_TOKEN");
  const accessTokenSecret = getSetting(runtime, "TWITTER_ACCESS_TOKEN_SECRET");
  if (!apiKey || !apiSecretKey || !accessToken || !accessTokenSecret) {
    return null;
  }
  return { apiKey, apiSecretKey, accessToken, accessTokenSecret };
}

function formEncode(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

async function exchangeCodeForToken(args: {
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<TwitterTokenResponse> {
  const body = formEncode({
    grant_type: "authorization_code",
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    code: args.code,
    code_verifier: args.codeVerifier,
  });
  const res = await fetch(TWITTER_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as TwitterTokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Twitter token exchange failed (${res.status}): ${JSON.stringify(json)}`,
    );
  }
  return json;
}

async function fetchAuthenticatedUser(
  accessToken: string,
): Promise<{ id: string; username?: string; name?: string }> {
  const res = await fetch(TWITTER_USERS_ME_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json().catch(() => ({}))) as TwitterUserMeResponse;
  if (!res.ok || !json.data?.id) {
    throw new Error(
      `Twitter users/me failed (${res.status}): ${JSON.stringify(json)}`,
    );
  }
  return {
    id: json.data.id,
    username: json.data.username,
    name: json.data.name,
  };
}

function buildAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(TWITTER_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("scope", args.scopes.join(" "));
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function readFlowMetadataString(
  metadata: unknown,
  key: string,
): string | undefined {
  const record =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function roleFromMetadata(metadata: unknown): ConnectorAccountRole {
  const record =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const raw =
    typeof record.role === "string"
      ? record.role
      : typeof record.accountRole === "string"
        ? record.accountRole
        : undefined;
  const normalized = raw?.trim().toUpperCase();
  if (
    normalized === "OWNER" ||
    normalized === "AGENT" ||
    normalized === "TEAM"
  ) {
    return normalized;
  }
  return "OWNER";
}

export function createXConnectorAccountProvider(
  runtime: IAgentRuntime,
): ConnectorAccountProvider {
  return {
    provider: X_PROVIDER,
    label: "X (Twitter)",

    async startOAuth(
      request: ConnectorOAuthStartRequest,
    ): Promise<ConnectorOAuthStartResult> {
      const { clientId, redirectUri } = readClientConfig(runtime);
      const scopes = readScopes(runtime, request.scopes);
      const resolvedRedirectUri = request.redirectUri ?? redirectUri;
      const codeVerifier = createCodeVerifier();
      const codeChallenge = createCodeChallenge(codeVerifier);
      const authUrl = buildAuthorizeUrl({
        clientId,
        redirectUri: resolvedRedirectUri,
        scopes,
        state: request.flow.state,
        codeChallenge,
      });
      return {
        authUrl,
        codeVerifier,
        metadata: {
          ...request.metadata,
          scopes,
          redirectUri: resolvedRedirectUri,
        },
      };
    },

    async completeOAuth(
      request: ConnectorOAuthCallbackRequest,
      manager?: ConnectorAccountManager,
    ): Promise<ConnectorOAuthCallbackResult> {
      if (!manager) {
        throw new Error(
          "X OAuth callback requires a ConnectorAccountManager to persist the connector account before credentials.",
        );
      }
      const config = readClientConfig(runtime);
      const redirectUri =
        request.flow.redirectUri ??
        readFlowMetadataString(request.flow.metadata, "redirectUri") ??
        config.redirectUri;
      const code = request.code ?? request.query.code;
      if (!code) {
        throw new Error("Twitter OAuth callback is missing authorization code");
      }
      const codeVerifier = request.flow.codeVerifier;
      if (!codeVerifier) {
        throw new Error(
          "Twitter OAuth flow is missing code verifier — restart the flow",
        );
      }
      const token = await exchangeCodeForToken({
        clientId: config.clientId,
        redirectUri,
        code,
        codeVerifier,
      });
      const accessToken = token.access_token;
      if (!accessToken) {
        throw new Error(
          "Twitter OAuth token exchange did not return an access_token",
        );
      }
      const me = await fetchAuthenticatedUser(accessToken);
      const expiresAt =
        typeof token.expires_in === "number"
          ? Date.now() + token.expires_in * 1000
          : undefined;
      const oauthCredentialVersion = String(Date.now());
      const accountMetadata = {
        authMethod: "oauth",
        username: me.username,
        name: me.name,
        scope: token.scope,
        tokenType: token.token_type,
        expiresAt,
        hasRefreshToken: Boolean(token.refresh_token),
        oauthCredentialVersion,
      };
      const pendingAccount = await manager.upsertAccount(
        X_PROVIDER,
        {
          externalId: me.id,
          displayHandle: me.username ?? me.id,
          label: me.name ?? me.username ?? me.id,
          role: roleFromMetadata(request.flow.metadata),
          purpose: [...DEFAULT_PURPOSES],
          accessGate: "open",
          status: "pending",
          metadata: accountMetadata,
        },
        request.flow.accountId,
      );
      const credentialPersist = await persistConnectorCredentialRefs({
        runtime,
        manager,
        provider: X_PROVIDER,
        accountIdForRef: pendingAccount.id,
        storageAccountId: pendingAccount.id,
        caller: "plugin-x",
        credentials: [
          {
            credentialType: "oauth.tokens",
            value: JSON.stringify({
              access_token: token.access_token,
              ...(token.refresh_token
                ? { refresh_token: token.refresh_token }
                : {}),
              ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
              ...(token.scope ? { scope: token.scope } : {}),
              ...(token.token_type ? { token_type: token.token_type } : {}),
            }),
            ...(expiresAt !== undefined ? { expiresAt } : {}),
            metadata: {
              provider: X_PROVIDER,
              hasRefreshToken: Boolean(token.refresh_token),
            },
          },
        ],
      });

      const account: ConnectorAccountPatch & { id: string } = {
        ...pendingAccount,
        id: pendingAccount.id,
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

      return {
        account,
        flow: { status: "completed" },
      };
    },
  };
}

/**
 * Materialize a synthetic `default` account when the plugin is configured via
 * environment variables and no SQL-backed account already represents that
 * credential set. This keeps single-account env mode addressable through the
 * ConnectorAccountManager surface.
 */
export async function materializeEnvAccountIfMissing(
  runtime: IAgentRuntime,
): Promise<void> {
  const credentials = readEnvCredentials(runtime);
  if (!credentials) {
    return;
  }
  const manager = getConnectorAccountManager(runtime);
  const existing = await manager.getAccount(X_PROVIDER, DEFAULT_ACCOUNT_ID);
  if (existing) {
    return;
  }
  const account: ConnectorAccount = {
    id: DEFAULT_ACCOUNT_ID,
    provider: X_PROVIDER,
    label: ENV_ACCOUNT_LABEL,
    role: "OWNER",
    purpose: [...DEFAULT_PURPOSES],
    accessGate: "open",
    status: "connected",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: { source: "env" },
  };
  try {
    await manager.upsertAccount(X_PROVIDER, account);
    logger.info(
      { src: "plugin:x", accountId: DEFAULT_ACCOUNT_ID },
      "Materialized synthetic X account from environment credentials",
    );
  } catch (err) {
    logger.warn(
      {
        src: "plugin:x",
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to materialize synthetic X env account",
    );
  }
}
