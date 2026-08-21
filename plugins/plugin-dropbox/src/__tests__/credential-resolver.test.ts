/**
 * DefaultDropboxCredentialResolver contract tests over a real in-memory
 * connector-account manager fake and a protocol-faithful fake token endpoint.
 * Covers BYO local token, fresh stored tokens, expiry-driven refresh with
 * in-memory caching, refresh rejection (revoked grant), unconfigured client
 * credentials, and missing-credential failure paths.
 */
import type { ConnectorAccount, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { DefaultDropboxCredentialResolver } from "../credential-resolver.js";

function runtimeWith(options: {
  settings?: Record<string, string>;
  accounts?: ConnectorAccount[];
}): IAgentRuntime {
  const accounts = options.accounts ?? [];
  const manager = {
    registerProvider: () => undefined,
    evaluatePolicy: async () => ({ allowed: true }),
    getAccount: async (_provider: string, id: string) =>
      accounts.find((account) => account.id === id) ?? null,
    listAccounts: async () => accounts,
    getStorage: () => ({
      listAccounts: async () => accounts,
      getAccount: async (_provider: string, id: string) =>
        accounts.find((account) => account.id === id) ?? null,
      upsertAccount: async (account: ConnectorAccount) => account,
      deleteAccount: async () => undefined,
    }),
  };
  return {
    agentId: "agent-1",
    getSetting: (key: string) => options.settings?.[key],
    getService: (type: string) => (type === "connector_account" ? manager : null),
  } as unknown as IAgentRuntime;
}

function accountWithTokens(tokens: Record<string, unknown>): ConnectorAccount {
  return {
    id: "acct-1",
    provider: "dropbox",
    role: "OWNER",
    purpose: ["drive"],
    accessGate: "open",
    status: "connected",
    metadata: {
      credentialRefs: [{ credentialType: "oauth.tokens", value: JSON.stringify(tokens) }],
    },
  } as ConnectorAccount;
}

const CLIENT_SETTINGS = {
  DROPBOX_CLIENT_ID: "app-key",
  DROPBOX_CLIENT_SECRET: "app-secret",
};

describe("DefaultDropboxCredentialResolver", () => {
  it("uses the BYO DROPBOX_ACCESS_TOKEN for the local default account", async () => {
    const resolver = new DefaultDropboxCredentialResolver(
      runtimeWith({ settings: { DROPBOX_ACCESS_TOKEN: "sl.byo" } })
    );
    await expect(resolver.getCredential({ accountId: "default" })).resolves.toEqual({
      accessToken: "sl.byo",
    });
  });

  it("returns a stored token that is still fresh without refreshing", async () => {
    const now = 1_000_000_000_000;
    const fetchImpl: typeof fetch = async () => {
      throw new Error("refresh must not be called for a fresh token");
    };
    const resolver = new DefaultDropboxCredentialResolver(
      runtimeWith({
        settings: CLIENT_SETTINGS,
        accounts: [
          accountWithTokens({
            access_token: "sl.fresh",
            refresh_token: "rt-1",
            expiry_date: now + 3_600_000,
            account_id: "dbid:one",
          }),
        ],
      }),
      { fetchImpl, now: () => now }
    );
    const credential = await resolver.getCredential({ accountId: "acct-1" });
    expect(credential.accessToken).toBe("sl.fresh");
    expect(credential.dropboxAccountId).toBe("dbid:one");
  });

  it("refreshes an expired token via the OAuth refresh grant and caches it", async () => {
    const now = 1_000_000_000_000;
    const refreshCalls: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      refreshCalls.push(String(init?.body));
      return new Response(JSON.stringify({ access_token: "sl.refreshed", expires_in: 14_400 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const resolver = new DefaultDropboxCredentialResolver(
      runtimeWith({
        settings: CLIENT_SETTINGS,
        accounts: [
          accountWithTokens({
            access_token: "sl.stale",
            refresh_token: "rt-1",
            expiry_date: now - 1,
          }),
        ],
      }),
      { fetchImpl, now: () => now }
    );
    const first = await resolver.getCredential({ accountId: "acct-1" });
    const second = await resolver.getCredential({ accountId: "acct-1" });
    expect(first.accessToken).toBe("sl.refreshed");
    expect(second.accessToken).toBe("sl.refreshed");
    expect(refreshCalls).toHaveLength(1);
    const body = new URLSearchParams(refreshCalls[0]);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
    expect(body.get("client_id")).toBe("app-key");
  });

  it("surfaces a rejected refresh as DROPBOX_AUTH_EXPIRED", async () => {
    const now = 1_000_000_000_000;
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    const resolver = new DefaultDropboxCredentialResolver(
      runtimeWith({
        settings: CLIENT_SETTINGS,
        accounts: [accountWithTokens({ refresh_token: "rt-revoked", expiry_date: now - 1 })],
      }),
      { fetchImpl, now: () => now }
    );
    await expect(resolver.getCredential({ accountId: "acct-1" })).rejects.toThrow(
      /refresh failed with 400/
    );
  });

  it("fails closed when a refresh is needed but client credentials are missing", async () => {
    const now = 1_000_000_000_000;
    const resolver = new DefaultDropboxCredentialResolver(
      runtimeWith({
        accounts: [accountWithTokens({ refresh_token: "rt-1", expiry_date: now - 1 })],
      }),
      { now: () => now }
    );
    await expect(resolver.getCredential({ accountId: "acct-1" })).rejects.toThrow(
      /DROPBOX_CLIENT_ID/
    );
  });

  it("fails with account-not-found and missing-credential errors", async () => {
    const resolver = new DefaultDropboxCredentialResolver(runtimeWith({}));
    await expect(resolver.getCredential({ accountId: "missing" })).rejects.toThrow(/not found/);

    const empty = new DefaultDropboxCredentialResolver(
      runtimeWith({ accounts: [accountWithTokens({})] })
    );
    await expect(empty.getCredential({ accountId: "acct-1" })).rejects.toThrow(/no token material/);
  });
});
