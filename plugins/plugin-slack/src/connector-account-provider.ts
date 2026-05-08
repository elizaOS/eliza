/**
 * Slack ConnectorAccountManager provider.
 *
 * Bridges plugin-slack to the @elizaos/core ConnectorAccountManager so the
 * generic HTTP CRUD + OAuth surface can list, create, patch, delete, and run
 * the OAuth v2 install flow for Slack workspaces.
 *
 * Single-account env-only configurations (SLACK_BOT_TOKEN, SLACK_APP_TOKEN)
 * are surfaced as a synthesized 'default' account with role 'OWNER' so
 * downstream consumers see a uniform list. Multi-account configs declared on
 * character.settings.slack are surfaced verbatim.
 */
import {
  type ConnectorAccount,
  type ConnectorAccountManager,
  type ConnectorAccountPatch,
  type ConnectorAccountProvider,
  type ConnectorOAuthCallbackRequest,
  type ConnectorOAuthCallbackResult,
  type ConnectorOAuthStartRequest,
  type ConnectorOAuthStartResult,
  type IAgentRuntime,
  logger,
} from "@elizaos/core";
import {
  DEFAULT_ACCOUNT_ID,
  listEnabledSlackAccounts,
  resolveSlackAccount,
} from "./accounts";
import { SLACK_SERVICE_NAME } from "./types";

const SLACK_OAUTH_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_OAUTH_TOKEN_URL = "https://slack.com/api/oauth.v2.access";

const DEFAULT_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "users:read",
];

interface SlackOAuthV2Response {
  ok: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id: string; name?: string };
  enterprise?: { id: string; name?: string } | null;
  authed_user?: {
    id: string;
    scope?: string;
    access_token?: string;
    token_type?: string;
  };
  incoming_webhook?: {
    channel?: string;
    channel_id?: string;
    configuration_url?: string;
    url?: string;
  };
}

function nowMs(): number {
  return Date.now();
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
  const clientId = readSetting(runtime, "SLACK_CLIENT_ID");
  const clientSecret = readSetting(runtime, "SLACK_CLIENT_SECRET");
  const redirectUri = readSetting(runtime, "SLACK_REDIRECT_URI");
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Slack OAuth requires SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, and SLACK_REDIRECT_URI to be configured.",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

function synthesizeAccount(
  accountId: string,
  name: string | undefined,
): ConnectorAccount {
  return {
    id: accountId,
    provider: SLACK_SERVICE_NAME,
    label: name ?? `Slack (${accountId})`,
    role: "OWNER",
    purpose: ["messaging"],
    accessGate: "open",
    status: "connected",
    createdAt: nowMs(),
    updatedAt: nowMs(),
    metadata: {
      synthesized: true,
      source: "env",
    },
  };
}

export function createSlackConnectorAccountProvider(
  runtime: IAgentRuntime,
): ConnectorAccountProvider {
  return {
    provider: SLACK_SERVICE_NAME,
    label: "Slack",

    listAccounts: async (
      manager: ConnectorAccountManager,
    ): Promise<ConnectorAccount[]> => {
      const persisted = await manager
        .getStorage()
        .listAccounts(SLACK_SERVICE_NAME);
      const persistedById = new Map(persisted.map((a) => [a.id, a]));

      const enabled = listEnabledSlackAccounts(runtime);
      const synthesized: ConnectorAccount[] = enabled
        .filter((account) => !persistedById.has(account.accountId))
        .map((account) => synthesizeAccount(account.accountId, account.name));

      if (synthesized.length === 0 && persisted.length === 0) {
        const fallback = resolveSlackAccount(runtime, DEFAULT_ACCOUNT_ID);
        if (fallback.botToken) {
          synthesized.push(
            synthesizeAccount(DEFAULT_ACCOUNT_ID, fallback.name),
          );
        }
      }

      return [...persisted, ...synthesized];
    },

    createAccount: async (input: ConnectorAccountPatch) => {
      return {
        ...input,
        provider: SLACK_SERVICE_NAME,
        role: input.role ?? "OWNER",
        purpose: input.purpose ?? ["messaging"],
        accessGate: input.accessGate ?? "open",
        status: input.status ?? "pending",
      };
    },

    patchAccount: async (
      _accountId: string,
      patch: ConnectorAccountPatch,
    ) => {
      return { ...patch, provider: SLACK_SERVICE_NAME };
    },

    deleteAccount: async (): Promise<void> => {
      // Token revocation is the runtime/secrets store's responsibility; the
      // manager removes the account row after this resolves.
    },

    startOAuth: async (
      request: ConnectorOAuthStartRequest,
    ): Promise<ConnectorOAuthStartResult> => {
      const config = readClientConfig(runtime);
      const redirectUri = request.redirectUri ?? config.redirectUri;
      const requestedScopes =
        request.scopes && request.scopes.length > 0
          ? request.scopes
          : DEFAULT_BOT_SCOPES;

      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        scope: requestedScopes.join(","),
        state: request.flow.state,
      });

      return {
        authUrl: `${SLACK_OAUTH_AUTHORIZE_URL}?${params.toString()}`,
        metadata: {
          ...request.metadata,
          requestedScopes,
          redirectUri,
        },
      };
    },

    completeOAuth: async (
      request: ConnectorOAuthCallbackRequest,
    ): Promise<ConnectorOAuthCallbackResult> => {
      const code = nonEmptyString(request.code);
      if (!code) {
        throw new Error("Slack OAuth callback is missing an authorization code.");
      }

      const config = readClientConfig(runtime);
      const redirectUri =
        nonEmptyString(request.flow.redirectUri) ??
        nonEmptyString(
          (request.flow.metadata as Record<string, unknown> | undefined)
            ?.redirectUri,
        ) ??
        config.redirectUri;

      const tokenParams = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
      });

      const response = await fetch(SLACK_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenParams.toString(),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Slack token exchange failed with ${response.status}: ${body}`);
      }
      const parsed = (await response.json()) as SlackOAuthV2Response;
      if (!parsed.ok || !parsed.access_token) {
        throw new Error(
          `Slack token exchange returned an error: ${parsed.error ?? "unknown"}`,
        );
      }

      const teamId = parsed.team?.id;
      if (!teamId) {
        throw new Error("Slack token exchange did not include a team id.");
      }
      const teamName = parsed.team?.name;
      const grantedScopes = parsed.scope ? parsed.scope.split(",") : [];

      const accountPatch: ConnectorAccountPatch & { provider: string } = {
        provider: SLACK_SERVICE_NAME,
        role: "OWNER",
        purpose: ["messaging"],
        accessGate: "open",
        status: "connected",
        externalId: teamId,
        displayHandle: teamName,
        label: teamName ?? `Slack workspace ${teamId}`,
        metadata: {
          teamId,
          teamName: teamName ?? null,
          appId: parsed.app_id ?? null,
          botUserId: parsed.bot_user_id ?? null,
          enterpriseId: parsed.enterprise?.id ?? null,
          authedUserId: parsed.authed_user?.id ?? null,
          tokenType: parsed.token_type ?? "bot",
          grantedScopes,
        },
      };

      logger.info(
        {
          src: "plugin:slack:connector",
          teamId,
          teamName,
        },
        "Slack OAuth completed",
      );

      return {
        account: accountPatch,
        flow: { status: "completed" },
      };
    },
  };
}
