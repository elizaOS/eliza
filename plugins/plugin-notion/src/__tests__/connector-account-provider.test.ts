/**
 * Notion connector-account-provider contract tests. Uses a real in-memory
 * ConnectorAccountManager-shaped fake (storage-backed upsert) plus a
 * protocol-faithful fake token endpoint via injected fetch — the system under
 * test is the real provider. Covers OAuth start URL shape, callback success
 * with credential-ref persistence via the shared connector-credential-refs
 * helper, missing-code, failed exchange, invalid payload, and unconfigured
 * client settings.
 */
import type {
  ConnectorAccount,
  ConnectorAccountManager,
  ConnectorOAuthCallbackRequest,
  ConnectorOAuthStartRequest,
  IAgentRuntime,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  createNotionConnectorAccountProvider,
  NOTION_TOKEN_ENDPOINT,
} from "../connector-account-provider.js";

function fakeRuntime(settings: Record<string, string>, services: Record<string, unknown> = {}) {
  const vaultStore = new Map<string, string>();
  const refs: Array<Record<string, unknown>> = [];
  const runtime = {
    agentId: "agent-1",
    getSetting: (key: string) => settings[key],
    getService: (type: string) => {
      if (type in services) return services[type];
      if (type === "vault") {
        return {
          set: async (key: string, value: string) => {
            vaultStore.set(key, value);
          },
        };
      }
      return null;
    },
  } as unknown as IAgentRuntime;
  return { runtime, vaultStore, refs };
}

function fakeManager() {
  const accounts = new Map<string, ConnectorAccount>();
  const credentialRefs: Array<Record<string, unknown>> = [];
  const storage = {
    listAccounts: async (provider: string) =>
      [...accounts.values()].filter((account) => account.provider === provider),
    getAccount: async (_provider: string, id: string) => accounts.get(id) ?? null,
    upsertAccount: async (account: ConnectorAccount) => {
      accounts.set(account.id, account);
      return account;
    },
    deleteAccount: async (_provider: string, id: string) => {
      accounts.delete(id);
    },
    setConnectorAccountCredentialRef: async (params: Record<string, unknown>) => {
      credentialRefs.push(params);
    },
  };
  const manager = {
    getStorage: () => storage,
    getAccount: async (provider: string, id: string) => storage.getAccount(provider, id),
    listAccounts: async (provider: string) => storage.listAccounts(provider),
    upsertAccount: async (
      provider: string,
      patch: Record<string, unknown>,
      accountId?: string
    ): Promise<ConnectorAccount> => {
      const id = accountId ?? `acct-${accounts.size + 1}`;
      const account = { ...(accounts.get(id) ?? {}), ...patch, id, provider } as ConnectorAccount;
      accounts.set(id, account);
      return account;
    },
  } as unknown as ConnectorAccountManager;
  return { manager, accounts, credentialRefs };
}

const SETTINGS = {
  NOTION_CLIENT_ID: "client-id",
  NOTION_CLIENT_SECRET: "client-secret",
  NOTION_REDIRECT_URI: "https://agent.example/oauth/notion/callback",
};

function startRequest(): ConnectorOAuthStartRequest {
  return {
    flow: { state: "state-123" },
    metadata: {},
  } as unknown as ConnectorOAuthStartRequest;
}

function callbackRequest(code: string | undefined): ConnectorOAuthCallbackRequest {
  return {
    code,
    flow: {
      state: "state-123",
      redirectUri: SETTINGS.NOTION_REDIRECT_URI,
      metadata: { redirectUri: SETTINGS.NOTION_REDIRECT_URI },
    },
  } as unknown as ConnectorOAuthCallbackRequest;
}

describe("Notion OAuth start", () => {
  it("builds the authorization URL with owner=user and no PKCE", async () => {
    const { runtime } = fakeRuntime(SETTINGS);
    const provider = createNotionConnectorAccountProvider(runtime);
    const { manager } = fakeManager();
    const result = await provider.startOAuth?.(startRequest(), manager);
    const url = new URL(result?.authUrl ?? "");
    expect(url.origin + url.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("owner")).toBe("user");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(result?.codeVerifier).toBeUndefined();
  });

  it("fails closed when client settings are missing", async () => {
    const { runtime } = fakeRuntime({});
    const provider = createNotionConnectorAccountProvider(runtime);
    const { manager } = fakeManager();
    await expect(provider.startOAuth?.(startRequest(), manager)).rejects.toThrow(
      /NOTION_CLIENT_ID/
    );
  });
});

describe("Notion OAuth callback", () => {
  it("exchanges the code with Basic auth, records workspace identity, and persists a durable credential ref", async () => {
    const { runtime, vaultStore } = fakeRuntime(SETTINGS);
    const tokenRequests: Array<{ url: string; auth: string | undefined; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      tokenRequests.push({
        url: String(input),
        auth: (init?.headers as Record<string, string>)?.Authorization,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(
        JSON.stringify({
          access_token: "secret_notion_token",
          bot_id: "bot-1",
          workspace_id: "ws-1",
          workspace_name: "Acme Workspace",
          workspace_icon: null,
          owner: {
            type: "user",
            user: { id: "u-1", name: "Ada", person: { email: "ada@acme.test" } },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    const provider = createNotionConnectorAccountProvider(runtime, { fetchImpl });
    const { manager, credentialRefs } = fakeManager();

    const result = await provider.completeOAuth?.(callbackRequest("auth-code"), manager);

    expect(tokenRequests[0].url).toBe(NOTION_TOKEN_ENDPOINT);
    expect(tokenRequests[0].auth).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`
    );
    expect((tokenRequests[0].body as { grant_type: string }).grant_type).toBe("authorization_code");

    expect(result?.account.status).toBe("connected");
    expect(result?.account.externalId).toBe("ws-1");
    expect(result?.account.label).toBe("Acme Workspace");
    const metadata = result?.account.metadata as Record<string, unknown>;
    expect(metadata.workspaceId).toBe("ws-1");
    // The raw token never lands in account metadata — only refs.
    expect(JSON.stringify(metadata)).not.toContain("secret_notion_token");
    expect(credentialRefs).toHaveLength(1);
    expect(credentialRefs[0].credentialType).toBe("oauth.tokens");
    const persisted = [...vaultStore.values()];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toContain("secret_notion_token");
  });

  it("rejects a callback without an authorization code", async () => {
    const { runtime } = fakeRuntime(SETTINGS);
    const provider = createNotionConnectorAccountProvider(runtime);
    const { manager } = fakeManager();
    await expect(provider.completeOAuth?.(callbackRequest(undefined), manager)).rejects.toThrow(
      /authorization code/
    );
  });

  it("surfaces a failed token exchange without marking anything connected", async () => {
    const { runtime } = fakeRuntime(SETTINGS);
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    const provider = createNotionConnectorAccountProvider(runtime, { fetchImpl });
    const { manager, accounts } = fakeManager();
    await expect(provider.completeOAuth?.(callbackRequest("bad"), manager)).rejects.toThrow(
      /token exchange failed with 400/
    );
    expect(accounts.size).toBe(0);
  });

  it("rejects a token payload without an access token", async () => {
    const { runtime } = fakeRuntime(SETTINGS);
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ workspace_id: "ws-1" }), { status: 200 });
    const provider = createNotionConnectorAccountProvider(runtime, { fetchImpl });
    const { manager } = fakeManager();
    await expect(provider.completeOAuth?.(callbackRequest("code"), manager)).rejects.toThrow(
      /invalid payload/
    );
  });
});
