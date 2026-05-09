import type {
  ConnectorAccount,
  ConnectorAccountPatch,
  IAgentRuntime,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createXConnectorAccountProvider } from "./connector-account-provider";

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
