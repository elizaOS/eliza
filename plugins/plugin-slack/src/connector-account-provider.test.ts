/**
 * Unit tests for the Slack `ConnectorAccountProvider` — how it lists, creates,
 * patches, and deletes accounts against a mocked `ConnectorAccountManager` and a
 * fake runtime whose `getSetting` returns canned env values. No live Slack API.
 */

import http from "node:http";
import {
  type ConnectorAccount,
  type ConnectorAccountPatch,
  getConnectorAccountManager,
  type IAgentRuntime,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSlackConnectorAccountProvider,
  exchangeSlackOAuthTokenWithFetch,
  SLACK_OAUTH_TIMEOUT_MS,
} from "./connector-account-provider";
import { SLACK_SERVICE_NAME } from "./types";

function runtime(settings: Record<string, unknown>): IAgentRuntime {
  return {
    character: {},
    getService: vi.fn(() => null),
    getSetting: vi.fn((key: string) => settings[key]),
  } as IAgentRuntime;
}

describe("Slack ConnectorAccountManager provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("lists legacy env credentials as a default OWNER account", async () => {
    const rt = runtime({ SLACK_BOT_TOKEN: "xoxb-test-token" });
    const manager = getConnectorAccountManager(rt);
    manager.registerProvider(createSlackConnectorAccountProvider(rt));

    const accounts = await manager.listAccounts(SLACK_SERVICE_NAME);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: "default",
      provider: SLACK_SERVICE_NAME,
      role: "OWNER",
      accessGate: "open",
      status: "connected",
      metadata: expect.objectContaining({
        isDefault: true,
        source: "env",
      }),
    });
    expect(accounts[0]?.purpose).toEqual(
      expect.arrayContaining(["messaging", "posting", "reading"]),
    );
  });

  it("creates, patches, and deletes stored accounts without hiding legacy default", async () => {
    const rt = runtime({ SLACK_BOT_TOKEN: "xoxb-test-token" });
    const manager = getConnectorAccountManager(rt);
    manager.registerProvider(createSlackConnectorAccountProvider(rt));

    const created = await manager.createAccount(SLACK_SERVICE_NAME, {
      label: "Team Slack",
      role: "TEAM",
      purpose: ["automation"],
      status: "connected",
    });

    expect(created).toMatchObject({
      provider: SLACK_SERVICE_NAME,
      label: "Team Slack",
      role: "TEAM",
      purpose: ["automation"],
      status: "connected",
    });

    const listed = await manager.listAccounts(SLACK_SERVICE_NAME);
    expect(listed.map((account) => account.id)).toEqual(
      expect.arrayContaining([created.id, "default"]),
    );

    const patched = await manager.patchAccount(SLACK_SERVICE_NAME, created.id, {
      label: "Renamed Slack",
      displayHandle: "team-slack",
    });
    expect(patched).toMatchObject({
      id: created.id,
      label: "Renamed Slack",
      displayHandle: "team-slack",
      role: "TEAM",
      purpose: ["automation"],
    });

    await expect(
      manager.deleteAccount(SLACK_SERVICE_NAME, created.id),
    ).resolves.toBe(true);
    await expect(
      manager.getAccount(SLACK_SERVICE_NAME, created.id),
    ).resolves.toBeNull();
  });

  it("persists callback tokens as credential refs without returning token metadata", async () => {
    const vault = new Map<string, string>();
    const setCredentialRef = vi.fn(async () => undefined);
    const rt = {
      agentId: "agent-1",
      character: {},
      getSetting: vi.fn(
        (key: string) =>
          ({
            SLACK_CLIENT_ID: "slack-client",
            SLACK_CLIENT_SECRET: "slack-secret",
            SLACK_REDIRECT_URI: "http://localhost/oauth/slack/callback",
          })[key],
      ),
      getService: (serviceType: string) =>
        serviceType === "vault"
          ? {
              set: async (key: string, value: string) => {
                vault.set(key, value);
              },
            }
          : null,
    } as IAgentRuntime;
    const manager = createOAuthCallbackManager(
      SLACK_SERVICE_NAME,
      "acct_slack_durable_1",
      setCredentialRef,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("slack.com/api/oauth.v2.access")) {
          return new Response(
            JSON.stringify({
              ok: true,
              access_token: "slack-access-token",
              refresh_token: "slack-refresh-token",
              expires_in: 3600,
              token_type: "bot",
              scope: "chat:write,channels:read",
              bot_user_id: "B123",
              app_id: "A123",
              team: { id: "T123", name: "Ada Team" },
              authed_user: {
                id: "U123",
                access_token: "slack-user-access-token",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected fetch ${href}`);
      }),
    );

    const provider = createSlackConnectorAccountProvider(rt);
    const result = await provider.completeOAuth?.(
      {
        provider: SLACK_SERVICE_NAME,
        code: "oauth-code",
        query: {},
        flow: {
          id: "flow-1",
          provider: SLACK_SERVICE_NAME,
          state: "state-1",
          status: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
      manager as never,
    );

    const account = result?.account as ConnectorAccount;
    const metadata = account.metadata as Record<string, unknown>;
    expect(account.id).toBe("acct_slack_durable_1");
    expect(JSON.stringify(metadata)).not.toContain("slack-access-token");
    expect(JSON.stringify(metadata)).not.toContain("slack-refresh-token");
    expect(JSON.stringify(metadata)).not.toContain("slack-user-access-token");
    expect(metadata.credentialRefs).toEqual([
      expect.objectContaining({
        credentialType: "oauth.tokens",
        vaultRef: "connector.agent-1.slack.acct_slack_durable_1.oauth_tokens",
      }),
    ]);
    expect(
      vault.get("connector.agent-1.slack.acct_slack_durable_1.oauth_tokens"),
    ).toContain("slack-access-token");
    expect(
      vault.get("connector.agent-1.slack.acct_slack_durable_1.oauth_tokens"),
    ).toContain("slack-refresh-token");
    expect(setCredentialRef).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct_slack_durable_1",
        credentialType: "oauth.tokens",
        vaultRef: "connector.agent-1.slack.acct_slack_durable_1.oauth_tokens",
      }),
    );
  });

  it("fails OAuth callback when no durable vault writer is available", async () => {
    const rt = {
      agentId: "agent-1",
      character: {},
      getSetting: vi.fn(
        (key: string) =>
          ({
            SLACK_CLIENT_ID: "slack-client",
            SLACK_CLIENT_SECRET: "slack-secret",
            SLACK_REDIRECT_URI: "http://localhost/oauth/slack/callback",
          })[key],
      ),
      getService: () => null,
    } as IAgentRuntime;
    const manager = createOAuthCallbackManager(
      SLACK_SERVICE_NAME,
      "acct_slack_durable_1",
      vi.fn(async () => undefined),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("slack.com/api/oauth.v2.access")) {
          return new Response(
            JSON.stringify({
              ok: true,
              access_token: "slack-access-token",
              refresh_token: "slack-refresh-token",
              expires_in: 3600,
              token_type: "bot",
              scope: "chat:write,channels:read",
              bot_user_id: "B123",
              app_id: "A123",
              team: { id: "T123", name: "Ada Team" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected fetch ${href}`);
      }),
    );

    const provider = createSlackConnectorAccountProvider(rt);
    await expect(
      provider.completeOAuth?.(
        {
          provider: SLACK_SERVICE_NAME,
          code: "oauth-code",
          query: {},
          flow: {
            id: "flow-1",
            provider: SLACK_SERVICE_NAME,
            state: "state-1",
            status: "pending",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
        manager as never,
      ),
    ).rejects.toThrow(/durable connector credential store|vault writer/i);
  });
});

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected slack oauth abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

function oauthRuntime(): IAgentRuntime {
  return {
    agentId: "agent-1",
    character: {},
    getSetting: vi.fn(
      (key: string) =>
        ({
          SLACK_CLIENT_ID: "slack-client",
          SLACK_CLIENT_SECRET: "slack-secret",
          SLACK_REDIRECT_URI: "http://localhost/oauth/slack/callback",
        })[key],
    ),
    getService: () => null,
  } as IAgentRuntime;
}

function oauthRequest() {
  return {
    provider: SLACK_SERVICE_NAME,
    code: "oauth-code",
    query: {},
    flow: {
      id: "flow-1",
      provider: SLACK_SERVICE_NAME,
      state: "state-1",
      status: "pending" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
}

describe("Slack OAuth token-exchange deadlines", () => {
  it("keeps a documented OAuth budget", () => {
    expect(SLACK_OAUTH_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled token exchange through completeOAuth()", async () => {
    const provider = createSlackConnectorAccountProvider(oauthRuntime(), {
      fetchImpl: stallUntilAborted(),
      oauthTimeoutMs: 10,
    });
    await expect(
      provider.completeOAuth?.(
        oauthRequest(),
        createOAuthCallbackManager(
          SLACK_SERVICE_NAME,
          "acct_slack_timeout",
          vi.fn(async () => undefined),
        ) as never,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("keeps the deadline active while the token response body stalls", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":true');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as import("node:net").AddressInfo;
    const fetchImpl: typeof fetch = (_input, init) =>
      fetch(`http://127.0.0.1:${address.port}/oauth`, init);
    const provider = createSlackConnectorAccountProvider(oauthRuntime(), {
      fetchImpl,
      oauthTimeoutMs: 10,
    });

    try {
      await expect(
        provider.completeOAuth?.(
          oauthRequest(),
          createOAuthCallbackManager(
            SLACK_SERVICE_NAME,
            "acct_slack_body_timeout",
            vi.fn(async () => undefined),
          ) as never,
        ),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("translates a completed token-exchange provider error", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("invalid_code", {
        status: 401,
        statusText: "Unauthorized",
      });
    const provider = createSlackConnectorAccountProvider(oauthRuntime(), {
      fetchImpl,
      oauthTimeoutMs: 1_000,
    });
    await expect(
      provider.completeOAuth?.(
        oauthRequest(),
        createOAuthCallbackManager(
          SLACK_SERVICE_NAME,
          "acct_slack_timeout",
          vi.fn(async () => undefined),
        ) as never,
      ),
    ).rejects.toThrow("Slack token exchange failed with 401");
  });

  it("translates a Slack ok:false token payload", async () => {
    const fetchImpl: typeof fetch = async () =>
      Response.json({ ok: false, error: "invalid_code" });
    await expect(
      exchangeSlackOAuthTokenWithFetch("client_id=x", fetchImpl, 1_000),
    ).rejects.toThrow("Slack token exchange returned an error: invalid_code");
  });

  it("exchanges an authorization code through completeOAuth()", async () => {
    const signals: AbortSignal[] = [];
    const vault = new Map<string, string>();
    const setCredentialRef = vi.fn(async () => undefined);
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({
        ok: true,
        access_token: "slack-access-token",
        refresh_token: "slack-refresh-token",
        expires_in: 3600,
        token_type: "bot",
        scope: "chat:write,channels:read",
        bot_user_id: "B123",
        app_id: "A123",
        team: { id: "T123", name: "Ada Team" },
      });
    };
    const rt = {
      ...oauthRuntime(),
      getService: (serviceType: string) =>
        serviceType === "vault"
          ? {
              set: async (key: string, value: string) => {
                vault.set(key, value);
              },
            }
          : null,
    } as IAgentRuntime;
    const provider = createSlackConnectorAccountProvider(rt, {
      fetchImpl,
      oauthTimeoutMs: 1_000,
    });
    const result = await provider.completeOAuth?.(
      oauthRequest(),
      createOAuthCallbackManager(
        SLACK_SERVICE_NAME,
        "acct_slack_success",
        setCredentialRef,
      ) as never,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(result?.account).toMatchObject({
      id: "acct_slack_success",
      status: "connected",
    });
    expect(
      vault.get("connector.agent-1.slack.acct_slack_success.oauth_tokens"),
    ).toContain("slack-access-token");
  });
});

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
