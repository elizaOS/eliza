/**
 * Tests account resolution precedence (env vars, character settings, connector
 * credentials) against a deterministic in-memory runtime — no live GitHub.
 */

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
import {
  createGitHubConnectorAccountProvider,
  createGitHubConnectorAccountProviderForTest,
} from "./connector-account-provider";

function runtime(settings: Record<string, unknown>): IAgentRuntime {
  return createTestRuntime({
    character: {},
    getSetting: vi.fn((key: string) => toRuntimeSetting(settings[key])),
  });
}

type RuntimeSetting = string | number | boolean | null;

interface TestRuntimeShape {
  agentId?: string;
  character?: unknown;
  getSetting?: (key: string) => RuntimeSetting;
  getService?: (serviceType: string) => unknown;
}

function toRuntimeSetting(value: unknown): RuntimeSetting {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? value
    : null;
}

function createTestRuntime(runtimeShape: TestRuntimeShape): IAgentRuntime {
  return Object.assign(Object.create(null) as IAgentRuntime, runtimeShape);
}

describe("GitHub account resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects non-loopback OAuth endpoint overrides before credentials can be sent", () => {
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      expect(() =>
        createGitHubConnectorAccountProviderForTest(runtime({}), {
          authorizationEndpoint: "http://127.0.0.1:3000/oauth/authorize",
          tokenEndpoint: "https://attacker.example/oauth/token",
          userEndpoint: "http://127.0.0.1:3000/user",
          requestTimeoutMs: 1_000,
        }),
      ).toThrow(/loopback URL/i);
    } finally {
      process.env.NODE_ENV = priorNodeEnv;
    }
  });

  it.each([
    "http://user:secret@127.0.0.1:3000/oauth/token",
    "http://127.0.0.1:3000/oauth/token?access_token=secret",
    "http://127.0.0.1:3000/oauth/token#secret",
  ])("rejects unsafe loopback endpoint data in %s", (tokenEndpoint) => {
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      expect(() =>
        createGitHubConnectorAccountProviderForTest(runtime({}), {
          authorizationEndpoint: "http://127.0.0.1:3000/oauth/authorize",
          tokenEndpoint,
          userEndpoint: "http://127.0.0.1:3000/user",
          requestTimeoutMs: 1_000,
        }),
      ).toThrow(/credential-free loopback URL/i);
    } finally {
      process.env.NODE_ENV = priorNodeEnv;
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, 60_001])(
    "rejects invalid OAuth test request deadline %s",
    (requestTimeoutMs) => {
      const priorNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "test";
      try {
        expect(() =>
          createGitHubConnectorAccountProviderForTest(runtime({}), {
            authorizationEndpoint: "http://127.0.0.1:3000/oauth/authorize",
            tokenEndpoint: "http://127.0.0.1:3000/oauth/token",
            userEndpoint: "http://127.0.0.1:3000/user",
            requestTimeoutMs,
          }),
        ).toThrow(/request timeout must be finite/i);
      } finally {
        process.env.NODE_ENV = priorNodeEnv;
      }
    },
  );

  it("disables the loopback endpoint seam outside test processes", () => {
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() =>
        createGitHubConnectorAccountProviderForTest(runtime({}), {
          authorizationEndpoint: "http://127.0.0.1:3000/oauth/authorize",
          tokenEndpoint: "http://127.0.0.1:3000/oauth/token",
          userEndpoint: "http://127.0.0.1:3000/user",
          requestTimeoutMs: 1_000,
        }),
      ).toThrow(/only when NODE_ENV=test/i);
    } finally {
      process.env.NODE_ENV = priorNodeEnv;
    }
  });

  it("rejects a caller-selected OAuth redirect outside the provider registration", async () => {
    const provider = createGitHubConnectorAccountProvider(
      runtime({
        GITHUB_OAUTH_CLIENT_ID: "github-client",
        GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
        GITHUB_OAUTH_REDIRECT_URI: "http://localhost/oauth/github/callback",
      }),
    );
    await expect(
      provider.startOAuth?.(
        {
          provider: "github",
          redirectUri: "https://attacker.example/oauth/callback",
          flow: { state: "provider-owned-state" },
        } as never,
        {} as never,
      ),
    ).rejects.toThrow(/match the provider registration/i);
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

  it("rejects a malformed GITHUB_ACCOUNTS value instead of reporting no accounts", () => {
    expect(() =>
      readGitHubAccounts(runtime({ GITHUB_ACCOUNTS: '{"accounts": [' })),
    ).toThrow(/GITHUB_ACCOUNTS/);
  });

  it("still treats an absent GITHUB_ACCOUNTS value as no configured accounts", () => {
    expect(readGitHubAccounts(runtime({}))).toEqual([]);
  });

  it("uses the token saved from Settings (GITHUB_TOKEN) as the user account", async () => {
    expect(
      await readGitHubAccountsWithConnectorCredentials(
        runtime({ GITHUB_TOKEN: "settings-token" }),
      ),
    ).toEqual([{ accountId: "user", role: "user", token: "settings-token" }]);
  });

  it("keeps an explicit user PAT ahead of the Settings token", async () => {
    expect(
      await readGitHubAccountsWithConnectorCredentials(
        runtime({
          GITHUB_USER_PAT: "user-token",
          GITHUB_TOKEN: "settings-token",
        }),
      ),
    ).toEqual([{ accountId: "user", role: "user", token: "user-token" }]);
  });

  it("keeps a connected connector user account ahead of the Settings token", async () => {
    const vaultRef = "connector.agent-1.github.acc_123.oauth_tokens";
    const runtime = runtimeWithConnectorStorage({
      accounts: [
        createConnectorAccount({
          id: "acc_123",
          role: "OWNER",
          metadata: {
            credentialRefs: [{ credentialType: "oauth.tokens", vaultRef }],
          },
        }),
      ],
      vaultValues: new Map([
        [
          vaultRef,
          JSON.stringify({
            access_token: "connector-owner-token",
            token_type: "bearer",
          }),
        ],
      ]),
      settings: { GITHUB_TOKEN: "settings-token" },
    });

    const accounts = await readGitHubAccountsWithConnectorCredentials(runtime);

    expect(accounts).toEqual([
      expect.objectContaining({
        accountId: "acc_123",
        role: "user",
        token: "connector-owner-token",
      }),
    ]);
    expect(resolveGitHubAccount(accounts, { role: "user" })).toEqual(
      expect.objectContaining({
        accountId: "acc_123",
        token: "connector-owner-token",
      }),
    );
  });

  it("applies a saved or cleared Settings token without a restart", async () => {
    const settings: Record<string, unknown> = {};
    const rt = createTestRuntime({
      agentId: "00000000-0000-4000-8000-000000000001",
      character: {},
      getSetting: (key: string) => toRuntimeSetting(settings[key]),
      getService: () => null,
    });
    const { GitHubService } = await import("./services/github-service");
    const service = (await GitHubService.start(
      rt,
      () => ({}) as never,
    )) as InstanceType<typeof GitHubService>;
    expect(service.getOctokit({ role: "user" })).toBeNull();

    settings.GITHUB_TOKEN = "settings-token";
    await service.reloadAccounts();
    expect(service.getOctokit({ role: "user" })).not.toBeNull();

    settings.GITHUB_TOKEN = null;
    await service.reloadAccounts();
    expect(service.getOctokit({ role: "user" })).toBeNull();
  });

  it("uses a connector account connected after start and stops using it once removed", async () => {
    const vaultRef = "connector.agent-1.github.acc_late.oauth_tokens";
    const accounts: ConnectorAccount[] = [];
    const runtime = runtimeWithConnectorStorage({
      accounts,
      vaultValues: new Map([
        [
          vaultRef,
          JSON.stringify({ access_token: "late-token", token_type: "bearer" }),
        ],
      ]),
    });
    const originalGetService = runtime.getService.bind(runtime);
    const { GitHubService } = await import("./services/github-service");
    const service = (await GitHubService.start(
      runtime,
      () => ({}) as never,
    )) as InstanceType<typeof GitHubService>;
    runtime.getService = ((serviceType: string) =>
      serviceType === "github"
        ? service
        : serviceType === "connector_account_storage" || serviceType === "vault"
          ? originalGetService(serviceType)
          : null) as typeof runtime.getService;
    const { buildResolvedClient } = await import("./action-helpers");
    expect(
      "error" in (await buildResolvedClient(runtime, { role: "user" })),
    ).toBe(true);

    // OAuth completes in the connector manager while the service runs.
    accounts.push(
      createConnectorAccount({
        id: "acc_late",
        role: "OWNER",
        metadata: {
          credentialRefs: [{ credentialType: "oauth.tokens", vaultRef }],
        },
      }),
    );
    const connected = await buildResolvedClient(
      runtime,
      { role: "user" },
      {
        refresh: "on-miss",
      },
    );
    expect("error" in connected ? null : connected.client).not.toBeNull();

    // Disconnect removes the account row.
    accounts.length = 0;
    expect(
      "error" in (await buildResolvedClient(runtime, { role: "user" })),
    ).toBe(true);
  });

  it.each(["clear", "stop"] as const)(
    "does not restore stale accounts after %s while a reload is pending",
    async (operation) => {
      const settings: Record<string, unknown> = { GITHUB_TOKEN: "old-token" };
      let waitForStorage: Promise<ConnectorAccount[]> | undefined;
      const rt = runtimeWithConnectorStorage({
        accounts: [],
        vaultValues: new Map(),
      });
      rt.getSetting = (key: string) => toRuntimeSetting(settings[key]);
      const storage = rt.getService("connector_account_storage") as unknown as {
        listAccounts: () => Promise<ConnectorAccount[]>;
      };
      vi.spyOn(storage, "listAccounts").mockImplementation(
        () => waitForStorage ?? Promise.resolve([]),
      );
      const { GitHubService } = await import("./services/github-service");
      const service = new GitHubService(rt, () => ({}) as never);
      await service.reloadAccounts();
      expect(service.getOctokit("user")).not.toBeNull();
      let release!: (accounts: ConnectorAccount[]) => void;
      waitForStorage = new Promise((resolve) => {
        release = resolve;
      });
      const pending = service.reloadAccounts();
      // Let account resolution reach the delayed connector storage boundary.
      await new Promise((resolve) => setTimeout(resolve, 0));
      waitForStorage = undefined;
      settings.GITHUB_TOKEN = null;
      const clearing =
        operation === "clear" ? service.reloadAccounts() : service.stop();
      const clientDuringClear = service.getOctokit("user");
      release([]);
      await Promise.all([pending, clearing]);
      expect(clientDuringClear).toBeNull();
      expect(service.getOctokit("user")).toBeNull();
    },
  );

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
    const runtime = createTestRuntime({
      agentId: "agent-1",
      character: {},
      getSetting: (key: string) =>
        ({
          GITHUB_OAUTH_CLIENT_ID: "github-client",
          GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
          GITHUB_OAUTH_REDIRECT_URI: "http://localhost/oauth/github/callback",
        })[key] ?? null,
      getService: (serviceType: string) =>
        serviceType === "vault"
          ? {
              set: async (key: string, value: string) => {
                vault.set(key, value);
              },
            }
          : null,
    });
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
          accountId: "acct_github_durable_1",
          codeVerifier: "github-pkce-verifier",
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
    const runtime = createTestRuntime({
      agentId: "agent-1",
      character: {},
      getSetting: (key: string) =>
        ({
          GITHUB_OAUTH_CLIENT_ID: "github-client",
          GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
          GITHUB_OAUTH_REDIRECT_URI: "http://localhost/oauth/github/callback",
        })[key] ?? null,
      getService: () => null,
    });
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
            accountId: "acct_github_durable_1",
            codeVerifier: "github-pkce-verifier",
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
  settings?: Record<string, string>;
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
  return createTestRuntime({
    agentId: "agent-1",
    character: {},
    getSetting: vi.fn((key: string) => options.settings?.[key] ?? null),
    getService: (serviceType: string) => {
      if (serviceType === "connector_account_storage") return storage;
      if (serviceType === "vault") {
        return {
          reveal: async (key: string) => options.vaultValues.get(key) ?? "",
        };
      }
      return null;
    },
  });
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
