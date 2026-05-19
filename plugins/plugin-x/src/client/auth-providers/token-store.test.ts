import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectorAccountTokenStore,
  RuntimeCacheTokenStore,
  type TokenStore,
} from "./token-store";

describe("OAuth token store", () => {
  it("keys runtime cache entries by accountId", async () => {
    const cache = new Map<string, unknown>();
    const runtime = {
      agentId: "agent-1",
      getCache: async <T>(key: string) => cache.get(key) as T | undefined,
      setCache: async <T>(key: string, value: T) => {
        cache.set(key, value);
      },
    };

    const store = new RuntimeCacheTokenStore(runtime, "secondary");
    await store.save({
      access_token: "access-token",
      expires_at: 123,
    });

    expect(cache.has("twitter/oauth2/tokens/agent-1/secondary")).toBe(true);
  });

  it("loads OAuth tokens from connector account credential refs before secondary stores", async () => {
    const vaultRef = "connector.agent-1.x.acct_x_1.oauth_tokens";
    const account = {
      id: "acct_x_1",
      provider: "x",
      label: "X User",
      role: "OWNER",
      purpose: ["posting"],
      accessGate: "open",
      status: "connected",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        credentialRefs: [{ credentialType: "oauth.tokens", vaultRef }],
      },
    };
    const storage = {
      async listAccounts(provider?: string) {
        return !provider || provider === "x" ? [account] : [];
      },
      async getAccount(provider: string, accountId: string) {
        return provider === "x" && accountId === account.id ? account : null;
      },
      async upsertAccount(next: typeof account) {
        return next;
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
    const vault = {
      reveal: vi.fn(async () =>
        JSON.stringify({
          access_token: "x-access-token",
          refresh_token: "x-refresh-token",
          expires_at: 123456,
          scope: "tweet.read users.read",
          token_type: "bearer",
        }),
      ),
      set: vi.fn(async () => undefined),
    };
    const runtime = {
      agentId: "agent-1",
      getService: (serviceType: string) => {
        if (serviceType === "connector_account_storage") return storage;
        if (serviceType === "vault") return vault;
        return null;
      },
    } as IAgentRuntime;
    const secondaryStore: TokenStore = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };

    const store = new ConnectorAccountTokenStore(
      runtime,
      "acct_x_1",
      secondaryStore,
    );
    await expect(store.load()).resolves.toMatchObject({
      access_token: "x-access-token",
      refresh_token: "x-refresh-token",
      expires_at: 123456,
    });

    expect(secondaryStore.load).not.toHaveBeenCalled();
    expect(vault.reveal).toHaveBeenCalledWith(vaultRef, "plugin-x");
  });
});
