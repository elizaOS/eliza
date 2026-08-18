/** Unit tests for the X ConnectorAccountManager provider (`createXConnectorAccountProvider`) over a mocked runtime and account manager. */
import type {
  ConnectorAccount,
  ConnectorAccountPatch,
  IAgentRuntime,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createXConnectorAccountProvider,
  exchangeXOauthTokenWithFetch,
  fetchXAuthenticatedUserWithFetch,
  X_OAUTH_TOKEN_TIMEOUT_MS,
  X_OAUTH_USERS_ME_TIMEOUT_MS,
} from "./connector-account-provider";

function asRuntime<T extends object>(runtime: T): IAgentRuntime & T {
  return runtime as IAgentRuntime & T;
}

describe("X connector account OAuth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("persists callback tokens as credential refs without returning token metadata", async () => {
    const vault = new Map<string, string>();
    const setCredentialRef = vi.fn(async () => undefined);
    const runtime = asRuntime({
      agentId: "agent-1",
      getSetting: (key: string) =>
        ({
          TWITTER_CLIENT_ID: "x-client",
          TWITTER_REDIRECT_URI: "http://localhost/oauth/x/callback",
        })[key],
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
      "x",
      "acct_x_durable_1",
      setCredentialRef,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("/oauth2/token")) {
          return new Response(
            JSON.stringify({
              access_token: "x-access-token",
              refresh_token: "x-refresh-token",
              expires_in: 7200,
              scope: "tweet.read tweet.write users.read offline.access",
              token_type: "bearer",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (href.includes("/users/me")) {
          return new Response(
            JSON.stringify({
              data: { id: "x-user-1", username: "ada", name: "Ada" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected fetch ${href}`);
      }),
    );

    const provider = createXConnectorAccountProvider(runtime);
    const result = await provider.completeOAuth?.(
      {
        provider: "x",
        code: "oauth-code",
        query: {},
        flow: {
          id: "flow-1",
          provider: "x",
          state: "state-1",
          status: "pending",
          codeVerifier: "verifier",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          metadata: { role: "TEAM" },
        },
      },
      manager as never,
    );

    const account = result?.account as ConnectorAccount;
    const metadata = account.metadata as Record<string, unknown>;
    expect(account.id).toBe("acct_x_durable_1");
    expect(account.role).toBe("TEAM");
    expect(JSON.stringify(metadata)).not.toContain("x-access-token");
    expect(JSON.stringify(metadata)).not.toContain("x-refresh-token");
    expect(metadata.credentialRefs).toEqual([
      expect.objectContaining({
        credentialType: "oauth.tokens",
        vaultRef: "connector.agent-1.x.acct_x_durable_1.oauth_tokens",
      }),
    ]);
    expect(
      vault.get("connector.agent-1.x.acct_x_durable_1.oauth_tokens"),
    ).toContain("x-access-token");
    expect(setCredentialRef).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct_x_durable_1",
        credentialType: "oauth.tokens",
        vaultRef: "connector.agent-1.x.acct_x_durable_1.oauth_tokens",
      }),
    );
  });

  it("fails OAuth callback when no durable credential writer is available", async () => {
    const runtime = asRuntime({
      agentId: "agent-1",
      getSetting: (key: string) =>
        ({
          TWITTER_CLIENT_ID: "x-client",
          TWITTER_REDIRECT_URI: "http://localhost/oauth/x/callback",
        })[key],
      getService: () => null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("/oauth2/token")) {
          return new Response(
            JSON.stringify({
              access_token: "x-access-token",
              refresh_token: "x-refresh-token",
              expires_in: 7200,
              scope: "tweet.read tweet.write users.read offline.access",
              token_type: "bearer",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (href.includes("/users/me")) {
          return new Response(
            JSON.stringify({
              data: { id: "x-user-1", username: "ada", name: "Ada" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected fetch ${href}`);
      }),
    );

    const provider = createXConnectorAccountProvider(runtime);
    const manager = createOAuthCallbackManager(
      "x",
      "acct_x_durable_1",
      vi.fn(async () => undefined),
    );
    await expect(
      provider.completeOAuth?.(
        {
          provider: "x",
          code: "oauth-code",
          query: {},
          flow: {
            id: "flow-1",
            provider: "x",
            state: "state-1",
            status: "pending",
            codeVerifier: "verifier",
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

function stallUntilAborted(label: string): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error(`expected ${label} abort signal`);
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

function oauthRuntime(): IAgentRuntime {
  return asRuntime({
    agentId: "agent-1",
    getSetting: (key: string) =>
      ({
        TWITTER_CLIENT_ID: "x-client",
        TWITTER_REDIRECT_URI: "http://localhost/oauth/x/callback",
      })[key],
    getService: () => null,
  });
}

function oauthRequest() {
  return {
    provider: "x" as const,
    code: "oauth-code",
    query: {},
    flow: {
      id: "flow-1",
      provider: "x" as const,
      state: "state-1",
      status: "pending" as const,
      codeVerifier: "verifier",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {},
    },
  };
}

const tokenArgs = {
  clientId: "x-client",
  redirectUri: "http://localhost/oauth/x/callback",
  code: "oauth-code",
  codeVerifier: "verifier",
};

describe("X OAuth request deadlines", () => {
  it("keeps a documented token-exchange budget", () => {
    expect(X_OAUTH_TOKEN_TIMEOUT_MS).toBe(15_000);
  });

  it("keeps a documented users/me budget", () => {
    expect(X_OAUTH_USERS_ME_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled token POST at the injected deadline", async () => {
    await expect(
      exchangeXOauthTokenWithFetch(tokenArgs, stallUntilAborted("token"), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("aborts a stalled users/me GET at the injected deadline", async () => {
    await expect(
      fetchXAuthenticatedUserWithFetch(
        "x-access-token",
        stallUntilAborted("users/me"),
        10,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed token POST", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("invalid_code", {
        status: 401,
        statusText: "Unauthorized",
      });
    await expect(
      exchangeXOauthTokenWithFetch(tokenArgs, fetchImpl, 1_000),
    ).rejects.toThrow("Twitter token exchange failed (401)");
  });

  it("surfaces a provider error from a completed users/me GET", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });
    await expect(
      fetchXAuthenticatedUserWithFetch("x-access-token", fetchImpl, 1_000),
    ).rejects.toThrow("Twitter users/me failed (503)");
  });

  it("uses the injected fetch for a successful completeOAuth()", async () => {
    const signals: AbortSignal[] = [];
    const vault = new Map<string, string>();
    const setCredentialRef = vi.fn(async () => undefined);
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.signal) signals.push(init.signal);
      const href = String(input);
      if (href.includes("/oauth2/token")) {
        return Response.json({
          access_token: "x-access-token",
          refresh_token: "x-refresh-token",
          expires_in: 7200,
          scope: "tweet.read tweet.write users.read offline.access",
          token_type: "bearer",
        });
      }
      if (href.includes("/users/me")) {
        return Response.json({
          data: { id: "x-user-1", username: "ada", name: "Ada" },
        });
      }
      throw new Error(`Unexpected fetch ${href}`);
    };
    const runtime = asRuntime({
      ...oauthRuntime(),
      getService: (serviceType: string) =>
        serviceType === "vault"
          ? {
              set: async (key: string, value: string) => {
                vault.set(key, value);
              },
            }
          : null,
    });
    const provider = createXConnectorAccountProvider(runtime, {
      fetchImpl,
      tokenTimeoutMs: 1_000,
      usersMeTimeoutMs: 1_000,
    });
    const result = await provider.completeOAuth?.(
      oauthRequest(),
      createOAuthCallbackManager(
        "x",
        "acct_x_success",
        setCredentialRef,
      ) as never,
    );
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(false);
    expect(signals[1]?.aborted).toBe(false);
    expect(result?.account).toMatchObject({
      id: "acct_x_success",
      status: "connected",
    });
    expect(vault.get("connector.agent-1.x.acct_x_success.oauth_tokens")).toContain(
      "x-access-token",
    );
  });

  it("aborts completeOAuth() when the token hop stalls", async () => {
    const provider = createXConnectorAccountProvider(oauthRuntime(), {
      fetchImpl: stallUntilAborted("token"),
      tokenTimeoutMs: 10,
      usersMeTimeoutMs: 1_000,
    });
    await expect(
      provider.completeOAuth?.(
        oauthRequest(),
        createOAuthCallbackManager(
          "x",
          "acct_x_timeout",
          vi.fn(async () => undefined),
        ) as never,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
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
