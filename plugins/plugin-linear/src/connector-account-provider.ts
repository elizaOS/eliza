/**
 * Linear ConnectorAccountManager provider.
 *
 * Bridges plugin-linear to the @elizaos/core ConnectorAccountManager so the
 * generic HTTP CRUD + OAuth surface can list, create, patch, delete, and run
 * the OAuth flow for Linear workspaces.
 *
 * Account model:
 *   - role "OWNER" — workspace admin (workspace API key or OAuth)
 *   - accountKey  — workspace id (or workspace handle if id unavailable)
 *   - purpose     — ["admin"]
 */

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
import { readLinearAccounts } from "./accounts";

export const LINEAR_PROVIDER_NAME = "linear";

const LINEAR_AUTHORIZATION_ENDPOINT = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";
const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

const DEFAULT_PURPOSES: ConnectorAccountPurpose[] = [
  "admin" as ConnectorAccountPurpose,
];

interface LinearTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface LinearViewerPayload {
  data?: {
    viewer?: {
      id?: string;
      name?: string;
      email?: string;
      organization?: {
        id?: string;
        name?: string;
        urlKey?: string;
      };
    };
  };
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
  const clientId = readSetting(runtime, "LINEAR_OAUTH_CLIENT_ID");
  const clientSecret = readSetting(runtime, "LINEAR_OAUTH_CLIENT_SECRET");
  const redirectUri = readSetting(runtime, "LINEAR_OAUTH_REDIRECT_URI");
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Linear OAuth requires LINEAR_OAUTH_CLIENT_ID, LINEAR_OAUTH_CLIENT_SECRET, and LINEAR_OAUTH_REDIRECT_URI to be configured.",
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

async function exchangeCodeForToken(args: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<LinearTokenResponse> {
  const response = await fetch(LINEAR_TOKEN_ENDPOINT, {
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
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Linear token exchange failed with ${response.status}: ${body}`,
    );
  }
  const parsed = (await response.json()) as LinearTokenResponse;
  if (parsed.error) {
    throw new Error(
      `Linear token exchange returned error ${parsed.error}: ${parsed.error_description ?? "no description"}`,
    );
  }
  if (!parsed.access_token) {
    throw new Error("Linear token exchange returned no access_token.");
  }
  return parsed;
}

async function fetchLinearViewer(
  accessToken: string,
): Promise<LinearViewerPayload> {
  const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query:
        "{ viewer { id name email organization { id name urlKey } } }",
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Linear viewer query failed with ${response.status}`,
    );
  }
  return (await response.json()) as LinearViewerPayload;
}

function synthesizeEnvAccounts(runtime: IAgentRuntime): ConnectorAccount[] {
  const now = Date.now();
  return readLinearAccounts(runtime).map((account) => ({
    id: account.accountId,
    provider: LINEAR_PROVIDER_NAME,
    label: account.label ?? `Linear (${account.accountId})`,
    role: "OWNER" as const,
    purpose: DEFAULT_PURPOSES,
    accessGate: "open" as const,
    status: "connected" as const,
    externalId: account.workspaceId,
    displayHandle: account.workspaceId ?? account.accountId,
    createdAt: now,
    updatedAt: now,
    metadata: {
      authMethod: "api_key",
      source: "env",
      defaultTeamKey: account.defaultTeamKey ?? null,
    },
  }));
}

/**
 * Build the Linear ConnectorAccountManager provider.
 */
export function createLinearConnectorAccountProvider(
  runtime: IAgentRuntime,
): ConnectorAccountProvider {
  return {
    provider: LINEAR_PROVIDER_NAME,
    label: "Linear",

    listAccounts: async (
      manager: ConnectorAccountManager,
    ): Promise<ConnectorAccount[]> => {
      const stored = await manager
        .getStorage()
        .listAccounts(LINEAR_PROVIDER_NAME);
      if (stored.length > 0) return stored;
      return synthesizeEnvAccounts(runtime);
    },

    createAccount: async (
      input: ConnectorAccountPatch,
      _manager: ConnectorAccountManager,
    ) => {
      return {
        ...input,
        provider: LINEAR_PROVIDER_NAME,
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
      return { ...patch, provider: LINEAR_PROVIDER_NAME };
    },

    deleteAccount: async (
      _accountId: string,
      _manager: ConnectorAccountManager,
    ): Promise<void> => {
      // Credential cleanup is the credential store's responsibility.
    },

    startOAuth: async (
      request: ConnectorOAuthStartRequest,
      _manager: ConnectorAccountManager,
    ): Promise<ConnectorOAuthStartResult> => {
      const config = readClientConfig(runtime);
      const redirectUri = request.redirectUri ?? config.redirectUri;
      const scopes =
        request.scopes && request.scopes.length > 0
          ? request.scopes
          : ["read", "write", "issues:create", "comments:create"];

      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scopes.join(","),
        state: request.flow.state,
        prompt: "consent",
      });

      return {
        authUrl: `${LINEAR_AUTHORIZATION_ENDPOINT}?${params.toString()}`,
        metadata: {
          ...request.metadata,
          requestedScopes: scopes,
          redirectUri,
        },
      };
    },

    completeOAuth: async (
      request: ConnectorOAuthCallbackRequest,
      _manager: ConnectorAccountManager,
    ): Promise<ConnectorOAuthCallbackResult> => {
      const code = nonEmptyString(request.code);
      if (!code) {
        throw new Error(
          "Linear OAuth callback is missing an authorization code.",
        );
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
        throw new Error("Linear token exchange returned no access_token.");
      }

      const viewerPayload = await fetchLinearViewer(tokens.access_token);
      const viewer = viewerPayload.data?.viewer;
      const organization = viewer?.organization;
      const workspaceId = nonEmptyString(organization?.id);
      const workspaceHandle = nonEmptyString(organization?.urlKey);
      const externalId = workspaceId ?? workspaceHandle;
      if (!externalId) {
        throw new Error(
          "Linear viewer payload did not include an organization id or urlKey.",
        );
      }

      const accountPatch: ConnectorAccountPatch & { provider: string } = {
        provider: LINEAR_PROVIDER_NAME,
        role: "OWNER",
        purpose: DEFAULT_PURPOSES,
        accessGate: "open",
        status: "connected",
        externalId,
        displayHandle: workspaceHandle ?? externalId,
        label:
          nonEmptyString(organization?.name) ??
          nonEmptyString(workspaceHandle) ??
          "Linear",
        metadata: {
          authMethod: "oauth",
          workspaceId: workspaceId ?? null,
          workspaceHandle: workspaceHandle ?? null,
          workspaceName: nonEmptyString(organization?.name) ?? null,
          viewerId: nonEmptyString(viewer?.id) ?? null,
          viewerEmail: nonEmptyString(viewer?.email) ?? null,
          viewerName: nonEmptyString(viewer?.name) ?? null,
          tokenType: nonEmptyString(tokens.token_type) ?? "bearer",
          grantedScopes: parseScopes(tokens.scope),
          hasRefreshToken: Boolean(tokens.refresh_token),
        },
      };

      logger.info(
        {
          src: "plugin:linear:connector",
          workspaceId: workspaceId ?? null,
          workspaceHandle: workspaceHandle ?? null,
        },
        "Linear OAuth completed",
      );

      return {
        account: accountPatch,
        flow: { status: "completed" },
      };
    },
  };
}
