import type {
  ConnectorAccount,
  ConnectorAccountPatch,
  IAgentRuntime,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readGitHubAccounts,
  readGitHubAccountsWithConnectorCredentials,
  resolveGitHubAccount,
  resolveGitHubAccountSelection,
} from "./accounts";
import { createGitHubConnectorAccountProvider } from "./connector-account-provider";

function runtime(settings: Record<string, unknown>): IAgentRuntime {
  return {
    character: {},
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

describe("GitHub account resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps legacy user/agent PATs as role-tagged accounts", () => {
    const accounts = readGitHubAccounts(
      runtime({
        GITHUB_USER_PAT: "user-token",
        GITHUB_AGENT_PAT: "agent-token",
      }),
    );

    expect(accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "user",
          role: "user",
          token: "user-token",
        }),
        expect.objectContaining({
          accountId: "agent",
          role: "agent",
          token: "agent-token",
        }),
      ]),
    );
  });

  it("resolves explicit accountId before role defaults", () => {
    const accounts = readGitHubAccounts(
      runtime({
        GITHUB_AGENT_PAT: "legacy-agent",
        GITHUB_ACCOUNTS: JSON.stringify({
          reviewer: { role: "user", token: "reviewer-token" },
        }),
      }),
    );
    const selection = resolveGitHubAccountSelection(
      { accountId: "reviewer", as: "agent" },
      "agent",
    );

    expect(resolveGitHubAccount(accounts, selection)).toMatchObject({
      accountId: "reviewer",
      role: "user",
      token: "reviewer-token",
    });
  });

  it("does not fall back to role defaults when an explicit accountId is missing", () => {
    const accounts = readGitHubAccounts(
      runtime({
        GITHUB_AGENT_PAT: "legacy-agent",
      }),
    );
    const selection = resolveGitHubAccountSelection(
      { accountId: "missing", as: "agent" },
      "agent",
    );

    expect(resolveGitHubAccount(accounts, selection)).toBeNull();
  });

  it("does not read token-shaped fields from account metadata", () => {
    const accounts = readGitHubAccounts(
      runtime({
        GITHUB_ACCOUNTS: JSON.stringify({
          reviewer: {
            role: "user",
            metadata: {
              token: "metadata-token",
              accessToken: "metadata-access",
            },
          },
        }),
      }),
    );

    expect(accounts).toEqual([]);
  });

  it("loads OAuth accounts from connector credential refs", async () => {
    const vaultRef = "connector.agent-1.github.acct_github_1.oauth_tokens";
    const account = createConnectorAccount({
      id: "acct_github_1",
      role: "AGENT",
      metadata: {
        credentialRefs: [{ credentialType: "oauth.tokens", vaultRef }],
      },
    });
    const runtime = runtimeWithConnectorStorage({
      accounts: [account],
      vaultValues: new Map([
        [
          vaultRef,
          JSON.stringify({
            access_token: "github-oauth-token",
            token_type: "bearer",
          }),
        ],
      ]),
    });

    const accounts = await readGitHubAccountsWithConnectorCredentials(runtime);

    expect(accounts).toEqual([
      expect.objectContaining({
        accountId: "acct_github_1",
        role: "agent",
        token: "github-oauth-token",
      }),
    ]);
  });

  it("persists callback tokens as credential refs without returning token metadata", async () => {
    const vault = new Map<string, string>();
    const setCredentialRef = vi.fn(async () => undefined);
    const runtime = {
      agentId: "agent-1",
      character: {},
      getSetting: (key: string) =>
        ({
          GITHUB_OAUTH_CLIENT_ID: "github-client",
          GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
          GITHUB_OAUTH_REDIRECT_URI: "http://localhost/oauth/github/callback",
        })[key],
      getService: (serviceType: string) =>
        serviceType === "vault"
          ? {
              set: async (key: string, value: string) => {
                vault.set(key, value);
              },
            }
          : null,
    } as unknown as IAgentRuntime;
    const manager = createOAuthCallbackManager(
      "github",
      "acct_github_durable_1",
      setCredentialRef,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("/login/oauth/access_token")) {
          return new Response(
            JSON.stringify({
              access_token: "github-access-token",
              refresh_token: "github-refresh-token",
              expires_in: 28800,
              token_type: "bearer",
              scope: "repo,read:user",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (href.includes("api.github.com/user")) {
          return new Response(
            JSON.stringify({
              id: 123,
              login: "ada",
              name: "Ada",
              email: "ada@example.com",
              type: "User",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected fetch ${href}`);
      }),
    );

    const provider = createGitHubConnectorAccountProvider(runtime);
    const result = await provider.completeOAuth?.(
      {
        provider: "github",
        code: "oauth-code",
        query: {},
        flow: {
          id: "flow-1",
          provider: "github",
          state: "state-1",
          status: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          metadata: { role: "TEAM" },
        },
      },
      manager as never,
    );

    const account = result?.account as ConnectorAccount;
    const metadata = account.metadata as Record<string, unknown>;
    expect(account.id).toBe("acct_github_durable_1");
    expect(account.role).toBe("TEAM");
    expect(JSON.stringify(metadata)).not.toContain("github-access-token");
    expect(JSON.stringify(metadata)).not.toContain("github-refresh-token");
    expect(metadata.credentialRefs).toEqual([
      expect.objectContaining({
        credentialType: "oauth.tokens",
        vaultRef: "connector.agent-1.github.acct_github_durable_1.oauth_tokens",
      }),
    ]);
    expect(
      vault.get("connector.agent-1.github.acct_github_durable_1.oauth_tokens"),
    ).toContain("github-access-token");
    expect(setCredentialRef).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct_github_durable_1",
        credentialType: "oauth.tokens",
        vaultRef: "connector.agent-1.github.acct_github_durable_1.oauth_tokens",
      }),
    );
  });

  it("fails OAuth callback when no durable vault writer is available", async () => {
    const runtime = {
      agentId: "agent-1",
      character: {},
      getSetting: (key: string) =>
        ({
          GITHUB_OAUTH_CLIENT_ID: "github-client",
          GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
          GITHUB_OAUTH_REDIRECT_URI: "http://localhost/oauth/github/callback",
        })[key],
      getService: () => null,
    } as unknown as IAgentRuntime;
    const manager = createOAuthCallbackManager(
      "github",
      "acct_github_durable_1",
      vi.fn(async () => undefined),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("/login/oauth/access_token")) {
          return new Response(
            JSON.stringify({
              access_token: "github-access-token",
              refresh_token: "github-refresh-token",
              expires_in: 28800,
              token_type: "bearer",
              scope: "repo,read:user",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (href.includes("api.github.com/user")) {
          return new Response(
            JSON.stringify({
              id: 123,
              login: "ada",
              name: "Ada",
              email: "ada@example.com",
              type: "User",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected fetch ${href}`);
      }),
    );

    const provider = createGitHubConnectorAccountProvider(runtime);
    await expect(
      provider.completeOAuth?.(
        {
          provider: "github",
          code: "oauth-code",
          query: {},
          flow: {
            id: "flow-1",
            provider: "github",
            state: "state-1",
            status: "pending",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            metadata: {},
          },
        },
        manager as never,
      ),
    ).rejects.toThrow(/durable connector credential store|vault writer/i);
  });
});

function createConnectorAccount(input: {
  id: string;
  role: ConnectorAccount["role"];
  metadata: ConnectorAccount["metadata"];
}): ConnectorAccount {
  return {
    id: input.id,
    provider: "github",
    label: "GitHub OAuth",
    role: input.role,
    purpose: ["posting"],
    accessGate: "open",
    status: "connected",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: input.metadata,
  };
}

function runtimeWithConnectorStorage(options: {
  accounts: ConnectorAccount[];
  vaultValues: Map<string, string>;
}): IAgentRuntime {
  const storage = {
    async listAccounts(provider?: string) {
      return options.accounts.filter(
        (account) => !provider || account.provider === provider,
      );
    },
    async getAccount(provider: string, accountId: string) {
      return (
        options.accounts.find(
          (account) =>
            account.provider === provider && account.id === accountId,
        ) ?? null
      );
    },
    async upsertAccount(account: ConnectorAccount) {
      return account;
    },
    async deleteAccount() {
      return false;
    },
    async createOAuthFlow(flow: unknown) {
      return flow;
    },
    async getOAuthFlow() {
      return null;
    },
    async updateOAuthFlow() {
      return null;
    },
    async deleteOAuthFlow() {
      return false;
    },
  };
  return {
    agentId: "agent-1",
    character: {},
    getSetting: vi.fn(() => undefined),
    getService: (serviceType: string) => {
      if (serviceType === "connector_account_storage") return storage;
      if (serviceType === "vault") {
        return {
          reveal: async (key: string) => options.vaultValues.get(key) ?? "",
        };
      }
      return null;
    },
  } as unknown as IAgentRuntime;
}

function createOAuthCallbackManager(
  provider: string,
  durableAccountId: string,
  setCredentialRef: ReturnType<typeof vi.fn>,
) {
  return {
    getStorage: () => ({
      setConnectorAccountCredentialRef: setCredentialRef,
    }),
    upsertAccount: vi.fn(
      async (
        providerId: string,
        input: ConnectorAccountPatch & { provider?: string },
        accountId?: string,
      ): Promise<ConnectorAccount> => ({
        id: accountId ?? durableAccountId,
        provider: providerId || provider,
        label: input.label,
        role: input.role ?? "OWNER",
        purpose: Array.isArray(input.purpose)
          ? input.purpose
          : input.purpose
            ? [input.purpose]
            : ["messaging"],
        accessGate: input.accessGate ?? "open",
        status: input.status ?? "pending",
        externalId: input.externalId ?? undefined,
        displayHandle: input.displayHandle ?? undefined,
        ownerBindingId: input.ownerBindingId ?? undefined,
        ownerIdentityId: input.ownerIdentityId ?? undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: input.metadata,
      }),
    ),
  };
}
