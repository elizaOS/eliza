/**
 * Notion ConnectorAccountManager provider. Bridges plugin-notion to the core
 * ConnectorAccountManager so the generic HTTP CRUD + OAuth surface can list,
 * create, patch, delete, and run the OAuth flow for Notion workspaces.
 *
 * Notion public-integration OAuth has no PKCE, no refresh tokens, and no
 * incremental scopes: the grant covers exactly the pages/databases the user
 * shares with the connection, selected inside Notion's own consent UI. Each
 * completed grant is bound to one workspace; workspace identity (id, name,
 * icon) is recorded on the account so deterministic code can select accounts.
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
  ElizaError,
  type IAgentRuntime,
  logger,
} from "@elizaos/core";
import { persistConnectorCredentialRefs } from "@elizaos/plugin-google-workspace/connector-credential-refs";
import { NOTION_SERVICE_NAME } from "./types.js";

export const NOTION_AUTHORIZATION_ENDPOINT = "https://api.notion.com/v1/oauth/authorize";
export const NOTION_TOKEN_ENDPOINT = "https://api.notion.com/v1/oauth/token";
/** Maximum time allowed for the Notion token exchange request. */
export const NOTION_OAUTH_FETCH_TIMEOUT_MS = 15_000;

interface NotionTokenResponse {
  access_token: string;
  bot_id?: string;
  workspace_id?: string;
  workspace_name?: string | null;
  workspace_icon?: string | null;
  owner?: {
    type?: string;
    user?: {
      id?: string;
      name?: string | null;
      person?: { email?: string };
    };
  };
  duplicated_template_id?: string | null;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readClientConfig(runtime: IAgentRuntime): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const clientId = nonEmptyString(runtime.getSetting?.("NOTION_CLIENT_ID"));
  const clientSecret = nonEmptyString(runtime.getSetting?.("NOTION_CLIENT_SECRET"));
  const redirectUri = nonEmptyString(runtime.getSetting?.("NOTION_REDIRECT_URI"));
  if (!clientId || !clientSecret || !redirectUri) {
    throw new ElizaError(
      "Notion OAuth requires NOTION_CLIENT_ID, NOTION_CLIENT_SECRET, and NOTION_REDIRECT_URI to be configured.",
      { code: "NOTION_OAUTH_NOT_CONFIGURED", severity: "fatal" }
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export async function exchangeNotionAuthorizationCode(
  args: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
  },
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = NOTION_OAUTH_FETCH_TIMEOUT_MS
): Promise<NotionTokenResponse> {
  const basic = Buffer.from(`${args.clientId}:${args.clientSecret}`).toString("base64");
  const response = await fetchImpl(NOTION_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new ElizaError(`Notion token exchange failed with ${response.status}.`, {
      code: "NOTION_OAUTH_TOKEN_EXCHANGE_FAILED",
      context: { status: response.status, body: body.slice(0, 500) },
      severity: "fatal",
    });
  }
  const parsed = (await response.json()) as NotionTokenResponse;
  if (!nonEmptyString(parsed?.access_token)) {
    throw new ElizaError("Notion token exchange returned an invalid payload.", {
      code: "NOTION_OAUTH_TOKEN_PAYLOAD_INVALID",
      severity: "fatal",
    });
  }
  return parsed;
}

/**
 * Build the Notion ConnectorAccountProvider: account CRUD adapters plus the
 * authorization-code OAuth flow that records workspace identity and persists
 * the workspace-bound access token as a durable credential ref.
 */
export function createNotionConnectorAccountProvider(
  runtime: IAgentRuntime,
  options: { fetchImpl?: typeof fetch } = {}
): ConnectorAccountProvider {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    provider: NOTION_SERVICE_NAME,
    label: "Notion",

    listAccounts: async (manager: ConnectorAccountManager): Promise<ConnectorAccount[]> => {
      return manager.getStorage().listAccounts(NOTION_SERVICE_NAME);
    },

    createAccount: async (input: ConnectorAccountPatch, _manager: ConnectorAccountManager) => {
      return {
        ...input,
        provider: NOTION_SERVICE_NAME,
        role: input.role ?? "OWNER",
        purpose: input.purpose ?? ["drive"],
        accessGate: input.accessGate ?? "open",
        status: input.status ?? "pending",
      };
    },

    patchAccount: async (
      _accountId: string,
      patch: ConnectorAccountPatch,
      _manager: ConnectorAccountManager
    ) => {
      return { ...patch, provider: NOTION_SERVICE_NAME };
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
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        owner: "user",
        state: request.flow.state,
      });
      return {
        authUrl: `${NOTION_AUTHORIZATION_ENDPOINT}?${params.toString()}`,
        redirectUri: config.redirectUri,
        metadata: {
          ...request.metadata,
          redirectUri: config.redirectUri,
        },
      };
    },

    completeOAuth: async (
      request: ConnectorOAuthCallbackRequest,
      manager: ConnectorAccountManager
    ): Promise<ConnectorOAuthCallbackResult> => {
      const code = nonEmptyString(request.code);
      if (!code) {
        throw new ElizaError("Notion OAuth callback is missing an authorization code.", {
          code: "NOTION_OAUTH_CODE_MISSING",
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

      const tokens = await exchangeNotionAuthorizationCode(
        {
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          redirectUri,
          code,
        },
        fetchImpl
      );

      const workspaceId = nonEmptyString(tokens.workspace_id);
      const externalId = workspaceId ?? nonEmptyString(tokens.bot_id);
      if (!externalId) {
        throw new ElizaError("Notion OAuth response did not include a workspace or bot id.", {
          code: "NOTION_OAUTH_IDENTITY_MISSING",
          severity: "fatal",
        });
      }
      const workspaceName = nonEmptyString(tokens.workspace_name);
      const ownerName = nonEmptyString(tokens.owner?.user?.name);
      const ownerEmail = nonEmptyString(tokens.owner?.user?.person?.email);
      const oauthCredentialVersion = String(Date.now());
      const accountMetadata = {
        workspaceId: workspaceId ?? null,
        workspaceName: workspaceName ?? null,
        workspaceIcon: nonEmptyString(tokens.workspace_icon) ?? null,
        botId: nonEmptyString(tokens.bot_id) ?? null,
        ownerName: ownerName ?? null,
        ownerEmail: ownerEmail ?? null,
        oauthCredentialVersion,
      };

      const pendingAccount = await manager.upsertAccount(
        NOTION_SERVICE_NAME,
        {
          provider: NOTION_SERVICE_NAME,
          role: "OWNER",
          purpose: ["drive"],
          accessGate: "open",
          status: "pending",
          externalId,
          displayHandle: workspaceName ?? ownerEmail,
          label: workspaceName ?? "Notion",
          metadata: accountMetadata,
        },
        request.flow.accountId
      );

      const credentialPersist = await persistConnectorCredentialRefs({
        runtime,
        manager,
        provider: NOTION_SERVICE_NAME,
        accountIdForRef: pendingAccount.id,
        storageAccountId: pendingAccount.id,
        caller: "plugin-notion",
        credentials: [
          {
            credentialType: "oauth.tokens",
            value: JSON.stringify({
              access_token: tokens.access_token,
              token_type: "Bearer",
              workspace_id: workspaceId ?? null,
              bot_id: nonEmptyString(tokens.bot_id) ?? null,
            }),
            metadata: { provider: NOTION_SERVICE_NAME, hasRefreshToken: false },
          },
        ],
      });

      logger.info(
        { src: "plugin:notion:connector", externalId, workspaceName: workspaceName ?? null },
        "Notion OAuth completed"
      );

      return {
        account: {
          ...pendingAccount,
          id: pendingAccount.id,
          provider: NOTION_SERVICE_NAME,
          status: "connected",
          metadata: {
            ...accountMetadata,
            credentialRefs: credentialPersist.refs,
            credentialRefStorage: {
              vaultAvailable: credentialPersist.vaultAvailable,
              storageAvailable: credentialPersist.storageAvailable,
            },
          },
        },
        flow: { status: "completed" },
      };
    },
  };
}
