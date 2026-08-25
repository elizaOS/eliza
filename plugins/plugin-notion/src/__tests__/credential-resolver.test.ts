/**
 * DefaultNotionCredentialResolver contract tests over a real in-memory
 * connector-account manager fake. Covers BYO local token, metadata-embedded
 * token-set refs, vault-ref reads, "default" single-account resolution,
 * not-found, not-connected, and missing-credential failure paths.
 */
import type { ConnectorAccount, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { accessTokenFromValue, DefaultNotionCredentialResolver } from "../credential-resolver.js";

function runtimeWith(options: {
  settings?: Record<string, string>;
  accounts?: ConnectorAccount[];
  vault?: Record<string, string>;
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
    getService: (type: string) => {
      if (type === "connector_account") return manager;
      if (type === "vault" && options.vault) {
        return { get: async (key: string) => options.vault?.[key] ?? null };
      }
      return null;
    },
    getConnectorAccountManager: () => manager,
  } as unknown as IAgentRuntime;
}

function account(overrides: Partial<ConnectorAccount>): ConnectorAccount {
  return {
    id: "acct-1",
    provider: "notion",
    role: "OWNER",
    purpose: ["drive"],
    accessGate: "open",
    status: "connected",
    ...overrides,
  } as ConnectorAccount;
}

describe("DefaultNotionCredentialResolver", () => {
  it("uses the BYO NOTION_TOKEN for the local default account", async () => {
    const resolver = new DefaultNotionCredentialResolver(
      runtimeWith({ settings: { NOTION_TOKEN: "ntn_local" } })
    );
    const credential = await resolver.getCredential({ accountId: "default" });
    expect(credential.accessToken).toBe("ntn_local");
  });

  it("reads a metadata-embedded token-set credential ref", async () => {
    const resolver = new DefaultNotionCredentialResolver(
      runtimeWith({
        accounts: [
          account({
            metadata: {
              workspaceId: "ws-1",
              credentialRefs: [
                {
                  credentialType: "oauth.tokens",
                  value: JSON.stringify({ access_token: "ntn_from_metadata" }),
                },
              ],
            },
          }),
        ],
      })
    );
    const credential = await resolver.getCredential({ accountId: "acct-1" });
    expect(credential.accessToken).toBe("ntn_from_metadata");
    expect(credential.workspaceId).toBe("ws-1");
  });

  it("resolves a vaultRef through the vault service", async () => {
    const resolver = new DefaultNotionCredentialResolver(
      runtimeWith({
        vault: {
          "connector.agent-1.notion.acct-1.oauth_tokens": JSON.stringify({
            access_token: "ntn_from_vault",
          }),
        },
        accounts: [
          account({
            metadata: {
              credentialRefs: [
                {
                  credentialType: "oauth.tokens",
                  vaultRef: "connector.agent-1.notion.acct-1.oauth_tokens",
                },
              ],
            },
          }),
        ],
      })
    );
    const credential = await resolver.getCredential({ accountId: "acct-1" });
    expect(credential.accessToken).toBe("ntn_from_vault");
  });

  it('resolves "default" to the sole connected account', async () => {
    const resolver = new DefaultNotionCredentialResolver(
      runtimeWith({
        accounts: [
          account({
            metadata: {
              credentialRefs: [{ credentialType: "oauth.tokens", value: "ntn_sole" }],
            },
          }),
        ],
      })
    );
    const credential = await resolver.getCredential({ accountId: "default" });
    expect(credential.accessToken).toBe("ntn_sole");
  });

  it("fails with NOTION_ACCOUNT_NOT_FOUND for an unknown account", async () => {
    const resolver = new DefaultNotionCredentialResolver(runtimeWith({}));
    await expect(resolver.getCredential({ accountId: "missing" })).rejects.toThrow(/not found/);
  });

  it("fails when the account is not connected", async () => {
    const resolver = new DefaultNotionCredentialResolver(
      runtimeWith({ accounts: [account({ status: "revoked" })] })
    );
    await expect(resolver.getCredential({ accountId: "acct-1" })).rejects.toThrow(/revoked/);
  });

  it("fails with a missing-credential error when no token material exists", async () => {
    const resolver = new DefaultNotionCredentialResolver(
      runtimeWith({ accounts: [account({ metadata: {} })] })
    );
    await expect(resolver.getCredential({ accountId: "acct-1" })).rejects.toThrow(
      /no access token/
    );
  });
});

describe("accessTokenFromValue", () => {
  it("passes raw tokens through and extracts JSON token sets", () => {
    expect(accessTokenFromValue("ntn_raw")).toBe("ntn_raw");
    expect(accessTokenFromValue(JSON.stringify({ access_token: "ntn_json" }))).toBe("ntn_json");
    expect(accessTokenFromValue(JSON.stringify({ other: true }))).toBeUndefined();
  });
});
