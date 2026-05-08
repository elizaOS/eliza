/**
 * GitHub ConnectorAccountManager provider.
 *
 * Bridges plugin-github to the @elizaos/core ConnectorAccountManager so the
 * generic HTTP CRUD + OAuth surface can list, create, patch, delete, and run
 * the OAuth flow for GitHub accounts. PATs remain supported as a legacy code
 * path; OAuth-app installations are exposed via startOAuth/completeOAuth.
 *
 * Account model:
 *   - role "OWNER" — the user persona acting on their own behalf (legacy GITHUB_USER_PAT)
 *   - role "AGENT" — the agent persona acting on its own behalf (legacy GITHUB_AGENT_PAT)
 * accountKey = GitHub username (login).
 */

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
  type IAgentRuntime,
  logger,
} from "@elizaos/core";
import {
  DEFAULT_GITHUB_AGENT_ACCOUNT_ID,
  DEFAULT_GITHUB_USER_ACCOUNT_ID,
  readGitHubAccounts,
} from "./accounts.js";
import { persistConnectorCredentialRefs } from "./connector-credential-refs.js";
import { GITHUB_SERVICE_TYPE } from "./types.js";

const GITHUB_AUTHORIZATION_ENDPOINT = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const GITHUB_USER_ENDPOINT = "https://api.github.com/user";

const DEFAULT_PURPOSES: ConnectorAccountPurpose[] = [
  "posting" as ConnectorAccountPurpose,
  "reading" as ConnectorAccountPurpose,
  "admin" as ConnectorAccountPurpose,
];

interface GitHubTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface GitHubUserPayload {
  login?: string;
  id?: number;
  name?: string;
  email?: string;
  type?: string;
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
  const clientId = readSetting(runtime, "GITHUB_OAUTH_CLIENT_ID");
  const clientSecret = readSetting(runtime, "GITHUB_OAUTH_CLIENT_SECRET");
  const redirectUri = readSetting(runtime, "GITHUB_OAUTH_REDIRECT_URI");
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "GitHub OAuth requires GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, and GITHUB_OAUTH_REDIRECT_URI to be configured.",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

function parseScopes(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function defaultRoleFromAccountId(accountId: string | undefined): ConnectorAccountRole {
  if (accountId === DEFAULT_GITHUB_USER_ACCOUNT_ID) return "OWNER";
  if (accountId === DEFAULT_GITHUB_AGENT_ACCOUNT_ID) return "AGENT";
  return "OWNER";
}

function roleFromMetadata(
  metadata: unknown,
  accountId: string | undefined
): ConnectorAccountRole {
  const record =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const raw = nonEmptyString(record.role ?? record.accountRole);
  const normalized = raw?.toUpperCase();
  if (normalized === "OWNER" || normalized === "AGENT" || normalized === "TEAM") {
    return normalized;
  }
  return defaultRoleFromAccountId(accountId);
}

async function exchangeCodeForToken(args: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<GitHubTokenResponse> {
  const response = await fetch(GITHUB_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
    }).toString(),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub token exchange failed with ${response.status}: ${body}`,
    );
  }
  const parsed = (await response.json()) as GitHubTokenResponse;
  if (parsed.error) {
    throw new Error(
      `GitHub token exchange returned error ${parsed.error}: ${parsed.error_description ?? "no description"}`,
    );
  }
  if (!parsed.access_token) {
    throw new Error("GitHub token exchange returned no access_token.");
  }
  return parsed;
}

async function fetchGitHubUser(accessToken: string): Promise<GitHubUserPayload> {
  const response = await fetch(GITHUB_USER_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub /user request failed with ${response.status}`);
  }
  const parsed = (await response.json()) as GitHubUserPayload;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GitHub /user returned an invalid payload.");
  }
  return parsed;
}

function synthesizeEnvAccounts(runtime: IAgentRuntime): ConnectorAccount[] {
  const now = Date.now();
  return readGitHubAccounts(runtime).map((account) => ({
    id: account.accountId,
    provider: GITHUB_SERVICE_TYPE,
    label: account.label ?? `GitHub ${account.role} (${account.accountId})`,
    role: account.role === "user" ? ("OWNER" as ConnectorAccountRole) : ("AGENT" as ConnectorAccountRole),
    purpose: DEFAULT_PURPOSES,
    accessGate: "open",
    status: "connected",
    displayHandle: account.accountId,
    createdAt: now,
    updatedAt: now,
    metadata: { authMethod: "pat", source: "env" },
  }));
}

/**
 * Build the GitHub ConnectorAccountManager provider.
 */
export function createGitHubConnectorAccountProvider(
  runtime: IAgentRuntime,
): ConnectorAccountProvider {
  return {
    provider: GITHUB_SERVICE_TYPE,
    label: "GitHub",

    listAccounts: async (manager: ConnectorAccountManager): Promise<ConnectorAccount[]> => {
      const stored = await manager.getStorage().listAccounts(GITHUB_SERVICE_TYPE);
      if (stored.length > 0) return stored;
      // Synthesize from legacy GITHUB_USER_PAT / GITHUB_AGENT_PAT env-vars when
      // SQL storage has not yet materialized rows for them.
      return synthesizeEnvAccounts(runtime);
    },

    createAccount: async (
      input: ConnectorAccountPatch,
      _manager: ConnectorAccountManager,
    ) => {
      return {
        ...input,
        provider: GITHUB_SERVICE_TYPE,
        role: input.role ?? "OWNER",
        purpose: input.purpose ?? DEFAULT_PURPOSES,
        accessGate: input.accessGate ?? "open",
        status: input.status ?? "pending",
      };
    },

    patchAccount: async (
      _accountId: string,
      patch: ConnectorAccountPatch,
      _manager: ConnectorAccountManager,
    ) => {
      return { ...patch, provider: GITHUB_SERVICE_TYPE };
    },

    deleteAccount: async (
      _accountId: string,
      _manager: ConnectorAccountManager,
    ): Promise<void> => {
      // Credential cleanup is the credential store's responsibility; the
      // manager removes the account row after this resolves.
    },

    startOAuth: async (
      request: ConnectorOAuthStartRequest,
      _manager: ConnectorAccountManager,
    ): Promise<ConnectorOAuthStartResult> => {
      const config = readClientConfig(runtime);
      const redirectUri = request.redirectUri ?? config.redirectUri;
      const scopes = request.scopes && request.scopes.length > 0
        ? request.scopes
        : ["repo", "read:user", "user:email", "notifications"];

      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        state: request.flow.state,
        scope: scopes.join(" "),
        allow_signup: "false",
      });

      return {
        authUrl: `${GITHUB_AUTHORIZATION_ENDPOINT}?${params.toString()}`,
        metadata: {
          ...request.metadata,
          requestedScopes: scopes,
          redirectUri,
        },
      };
    },

    completeOAuth: async (
      request: ConnectorOAuthCallbackRequest,
      manager: ConnectorAccountManager,
    ): Promise<ConnectorOAuthCallbackResult> => {
      const code = nonEmptyString(request.code);
      if (!code) {
        throw new Error("GitHub OAuth callback is missing an authorization code.");
      }

      const config = readClientConfig(runtime);
      const redirectUri =
        nonEmptyString(request.flow.redirectUri) ?? config.redirectUri;

      const tokens = await exchangeCodeForToken({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri,
        code,
      });

      if (!tokens.access_token) {
        throw new Error("GitHub token exchange returned no access_token.");
      }

      const user = await fetchGitHubUser(tokens.access_token);
      const externalId = nonEmptyString(user.id ? String(user.id) : undefined);
      const login = nonEmptyString(user.login);
      if (!login) {
        throw new Error("GitHub /user payload did not include a login.");
      }
      const expiresAt =
        typeof tokens.expires_in === "number"
          ? Date.now() + tokens.expires_in * 1000
          : undefined;
      const credentialPersist = await persistConnectorCredentialRefs({
        runtime,
        manager,
        provider: GITHUB_SERVICE_TYPE,
        accountIdForRef: request.flow.accountId ?? login,
        storageAccountId: request.flow.accountId,
        caller: "plugin-github",
        credentials: [
          {
            credentialType: "oauth.tokens",
            value: JSON.stringify({
              access_token: tokens.access_token,
              ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
              ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
              token_type: nonEmptyString(tokens.token_type) ?? "bearer",
              scope: tokens.scope ?? "",
            }),
            ...(expiresAt !== undefined ? { expiresAt } : {}),
            metadata: {
              provider: GITHUB_SERVICE_TYPE,
              hasRefreshToken: Boolean(tokens.refresh_token),
            },
          },
        ],
      });

      const accountPatch: ConnectorAccountPatch & { provider: string } = {
        provider: GITHUB_SERVICE_TYPE,
        role: roleFromMetadata(request.flow.metadata, request.flow.accountId),
        purpose: DEFAULT_PURPOSES,
        accessGate: "open",
        status: "connected",
        externalId: externalId ?? login,
        displayHandle: login,
        label: nonEmptyString(user.name) ?? login,
        metadata: {
          authMethod: "oauth",
          login,
          githubUserId: user.id ?? null,
          email: nonEmptyString(user.email) ?? null,
          type: nonEmptyString(user.type) ?? null,
          tokenType: nonEmptyString(tokens.token_type) ?? "bearer",
          grantedScopes: parseScopes(tokens.scope),
          hasRefreshToken: Boolean(tokens.refresh_token),
          expiresAt,
          credentialRefs: credentialPersist.refs,
          credentialRefStorage: {
            vaultAvailable: credentialPersist.vaultAvailable,
            storageAvailable: credentialPersist.storageAvailable,
          },
          oauthCredentialVersion: String(Date.now()),
        },
      };

      logger.info(
        {
          src: "plugin:github:connector",
          login,
        },
        "GitHub OAuth completed",
      );

      return {
        account: accountPatch,
        flow: { status: "completed" },
      };
    },
  };
}
