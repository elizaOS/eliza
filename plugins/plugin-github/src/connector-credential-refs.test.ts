import type { ConnectorAccount, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  credentialRefRecordsFromMetadata,
  loadConnectorOAuthAccessToken,
  persistConnectorCredentialRefs,
} from "./connector-credential-refs";

function createRuntime(input: {
  agentId?: string;
  services?: Record<string, unknown>;
  adapter?: unknown;
}): IAgentRuntime {
  return Object.assign(Object.create(null) as IAgentRuntime, {
    agentId: input.agentId,
    adapter: input.adapter,
    getService: vi.fn((serviceType: string) => input.services?.[serviceType]),
  });
}

function connectorAccount(input: {
  id: string;
  metadata?: ConnectorAccount["metadata"];
}): ConnectorAccount {
  return {
    id: input.id,
    provider: "github",
    label: "GitHub",
    role: "AGENT",
    purpose: ["reading"],
    accessGate: "open",
    status: "connected",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: input.metadata ?? {},
  };
}

describe("GitHub connector credential refs", () => {
  it("extracts valid credential refs from supported metadata shapes and ignores malformed entries", () => {
    const records = credentialRefRecordsFromMetadata({
      credentialRefs: [
        {
          credentialType: "oauth.tokens",
          vaultRef: "connector.agent.github.account.oauth_tokens",
          metadata: { source: "array" },
        },
        { credentialType: "oauth.tokens" },
        "not-a-ref",
        null,
      ],
      oauthCredentialRefs: {
        "installation.token": " connector.agent.github.account.installation ",
        "bad.token": "   ",
        nested: {
          type: "oauth.refresh",
          ref: "connector.agent.github.account.refresh",
          credentialVersion: 7,
        },
      },
      oauth: {
        credentialRefs: [
          {
            name: "oauth.extra",
            ref: "connector.agent.github.account.extra",
          },
        ],
      },
    });

    expect(records).toEqual([
      expect.objectContaining({
        credentialType: "oauth.tokens",
        vaultRef: "connector.agent.github.account.oauth_tokens",
        metadata: { source: "array" },
      }),
      {
        credentialType: "installation.token",
        vaultRef: "connector.agent.github.account.installation",
      },
      expect.objectContaining({
        credentialType: "nested",
        vaultRef: "connector.agent.github.account.refresh",
        version: 7,
      }),
      expect.objectContaining({
        credentialType: "oauth.extra",
        vaultRef: "connector.agent.github.account.extra",
      }),
    ]);
  });

  it("loads OAuth access tokens from vault refs and rejects malformed secret payloads", async () => {
    const validRef = "connector.agent.github.valid.oauth_tokens";
    const invalidRef = "connector.agent.github.invalid.oauth_tokens";
    const vault = {
      reveal: vi.fn(async (key: string) => {
        if (key === validRef) {
          return JSON.stringify({ access_token: "github-oauth-token" });
        }
        if (key === invalidRef) {
          return JSON.stringify({ token: "not-an-access-token" });
        }
        return "";
      }),
    };
    const runtime = createRuntime({
      services: {
        connector_account: {
          registerProvider: vi.fn(),
          evaluatePolicy: vi.fn(),
          listAccounts: vi.fn(async () => [
            connectorAccount({
              id: "valid",
              metadata: {
                credentialRefs: [
                  {
                    credentialType: "OAUTH.TOKENS",
                    vaultRef: validRef,
                  },
                ],
              },
            }),
            connectorAccount({
              id: "invalid",
              metadata: {
                credentialRefs: [
                  {
                    credentialType: "oauth.tokens",
                    vaultRef: invalidRef,
                  },
                ],
              },
            }),
          ]),
        },
        vault,
      },
    });

    await expect(
      loadConnectorOAuthAccessToken({
        runtime,
        provider: "github",
        accountId: "valid",
        caller: "plugin-github-test",
      }),
    ).resolves.toBe("github-oauth-token");
    await expect(
      loadConnectorOAuthAccessToken({
        runtime,
        provider: "github",
        accountId: "invalid",
        caller: "plugin-github-test",
      }),
    ).resolves.toBeNull();
    expect(vault.reveal).toHaveBeenCalledWith(
      validRef,
      "plugin-github-test",
    );
  });

  it("persists credentials with fallback vault and credential-ref writers", async () => {
    const putSecret = vi.fn(async () => {
      throw new Error("primary vault unavailable");
    });
    const vaultSet = vi.fn(async () => undefined);
    const storageWriter = vi.fn(async () => {
      throw new Error("primary storage unavailable");
    });
    const adapterWriter = vi.fn(async () => undefined);
    const runtime = createRuntime({
      agentId: "agent 1",
      services: {
        connector_credential_store: { putSecret },
        vault: { set: vaultSet },
      },
      adapter: { setCredentialRef: adapterWriter },
    });
    const manager = {
      getStorage: () => ({
        setConnectorAccountCredentialRef: storageWriter,
      }),
    };

    const result = await persistConnectorCredentialRefs({
      runtime,
      manager: manager as never,
      provider: "github",
      accountIdForRef: "acct github/1",
      storageAccountId: "acct-storage-1",
      caller: "plugin-github-test",
      credentials: [
        {
          credentialType: "oauth.tokens",
          value: JSON.stringify({ access_token: "github-oauth-token" }),
          expiresAt: 123456,
          metadata: { provider: "github" },
        },
      ],
    });

    expect(result).toEqual({
      refs: [
        {
          credentialType: "oauth.tokens",
          vaultRef: "connector.agent_1.github.acct_github_1.oauth_tokens",
          expiresAt: 123456,
          metadata: { provider: "github" },
        },
      ],
      vaultAvailable: true,
      storageAvailable: true,
    });
    expect(putSecret).toHaveBeenCalledOnce();
    expect(vaultSet).toHaveBeenCalledWith(
      "connector.agent_1.github.acct_github_1.oauth_tokens",
      JSON.stringify({ access_token: "github-oauth-token" }),
      { sensitive: true, caller: "plugin-github-test" },
    );
    expect(storageWriter).toHaveBeenCalledOnce();
    expect(adapterWriter).toHaveBeenCalledWith({
      accountId: "acct-storage-1",
      credentialType: "oauth.tokens",
      vaultRef: "connector.agent_1.github.acct_github_1.oauth_tokens",
      expiresAt: 123456,
      metadata: { provider: "github" },
    });
  });

  it("refuses to persist credentials when no durable account id is available", async () => {
    const runtime = createRuntime({
      services: {
        vault: { set: vi.fn(async () => undefined) },
      },
    });

    await expect(
      persistConnectorCredentialRefs({
        runtime,
        provider: "github",
        accountIdForRef: "temporary-account",
        caller: "plugin-github-test",
        credentials: [
          {
            credentialType: "oauth.tokens",
            value: JSON.stringify({ access_token: "github-oauth-token" }),
          },
        ],
      }),
    ).rejects.toThrow(/no durable connector account id/i);
  });
});
