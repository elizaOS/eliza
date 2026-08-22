/** Verifies linked-account response and mutation contracts at the transport boundary. */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client";
import { ACCOUNTS_RESPONSE_INVALID_CODE } from "./client-agent-accounts-validator";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function accountsClient(body: unknown): ElizaClient {
  const client = new ElizaClient("http://agent.example:31337", "token");
  client.setRequestTransport({
    request: vi.fn(async () => jsonResponse(body)),
  });
  return client;
}

describe("ElizaClient account replacement transport", () => {
  it("accepts the canonical providers response and preserves server metadata", async () => {
    const body = {
      providers: [
        {
          providerId: "openai-api",
          strategy: "priority",
          runtimeEligibility: {
            chat: { available: true, credentialPath: "direct-api" },
            codingAgent: {
              available: true,
              backend: "codex",
              credentialPath: "direct-api",
            },
          },
          accounts: [
            {
              id: "primary",
              providerId: "openai-api",
              label: "Primary",
              source: "api-key",
              enabled: true,
              priority: 0,
              createdAt: 1,
              health: "ok",
              hasCredential: true,
              observability: { activeLeaseCount: 0 },
            },
          ],
        },
      ],
    };

    await expect(accountsClient(body).listAccounts()).resolves.toEqual(body);
  });

  it("rejects server metadata that advertises an unspawnable account provider", async () => {
    const body = {
      providers: [
        {
          providerId: "deepseek-api",
          strategy: "priority",
          runtimeEligibility: {
            chat: { available: true, credentialPath: "direct-api" },
            codingAgent: {
              available: true,
              backend: "opencode",
              credentialPath: "direct-api",
            },
          },
          accounts: [],
        },
      ],
    };

    await expect(accountsClient(body).listAccounts()).rejects.toMatchObject({
      code: ACCOUNTS_RESPONSE_INVALID_CODE,
      context: {
        path: "response.providers[0].runtimeEligibility.codingAgent.available",
      },
    });
  });

  it.each([
    [
      "chat availability",
      {
        chat: { available: false, credentialPath: "none" },
        codingAgent: {
          available: true,
          backend: "codex",
          credentialPath: "direct-api",
        },
      },
      "response.providers[0].runtimeEligibility.chat.available",
    ],
    [
      "chat credential path",
      {
        chat: { available: true, credentialPath: "account-pool" },
        codingAgent: {
          available: true,
          backend: "codex",
          credentialPath: "direct-api",
        },
      },
      "response.providers[0].runtimeEligibility.chat.credentialPath",
    ],
    [
      "coding credential path",
      {
        chat: { available: true, credentialPath: "direct-api" },
        codingAgent: {
          available: true,
          backend: "codex",
          credentialPath: "account-pool",
        },
      },
      "response.providers[0].runtimeEligibility.codingAgent.credentialPath",
    ],
  ])(
    "rejects contradictory descriptor-derived %s",
    async (_label, eligibility, path) => {
      const body = {
        providers: [
          {
            providerId: "openai-api",
            strategy: "priority",
            runtimeEligibility: eligibility,
            accounts: [],
          },
        ],
      };

      await expect(accountsClient(body).listAccounts()).rejects.toMatchObject({
        code: ACCOUNTS_RESPONSE_INVALID_CODE,
        context: { path },
      });
    },
  );

  it.each([
    [
      "the legacy walkthrough shape",
      { accounts: [] },
      "response.providers",
      "an array",
    ],
    [
      "a non-array provider list",
      { providers: {} },
      "response.providers",
      "an array",
    ],
    [
      "an account missing required fields",
      {
        providers: [
          {
            providerId: "openai-api",
            strategy: "priority",
            accounts: [{ id: "broken" }],
          },
        ],
      },
      "response.providers[0].accounts[0].providerId",
      "a supported linked-account provider",
    ],
    [
      "an account assigned to the wrong provider",
      {
        providers: [
          {
            providerId: "openai-api",
            strategy: "priority",
            accounts: [
              {
                id: "wrong-parent",
                providerId: "anthropic-api",
                label: "Wrong parent",
                source: "api-key",
                enabled: true,
                priority: 0,
                createdAt: 1,
                health: "ok",
                hasCredential: true,
              },
            ],
          },
        ],
      },
      "response.providers[0].accounts[0].providerId",
      'the parent provider "openai-api"',
    ],
  ])("rejects %s", async (_label, body, path, expected) => {
    const outcome = await accountsClient(body)
      .listAccounts()
      .then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.error).toBeInstanceOf(ElizaError);
    expect(outcome.error).toMatchObject({
      code: ACCOUNTS_RESPONSE_INVALID_CODE,
      context: { path, expected },
    });
  });

  it("sends explicit API-key and OAuth replacement targets", async () => {
    const request = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        const body = url.endsWith("/oauth/start")
          ? {
              sessionId: "repair-session",
              authUrl: "https://provider.example/authorize",
              needsCodeSubmission: true,
            }
          : {
              id: "account-1",
              providerId: "openai-api",
              label: "Primary",
              source: "api-key",
              enabled: true,
              priority: 0,
              createdAt: 1,
              health: "ok",
            };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.setRequestTransport({ request });

    const apiKeyReplacement = {
      label: "Primary",
      apiKey: "replacement-secret",
      replaceAccountId: "account-1",
    };
    const oauthReplacement = {
      label: "Work Codex",
      mode: "device" as const,
      replaceAccountId: "codex-work",
    };
    await client.createApiKeyAccount("openai-api", apiKeyReplacement);
    await client.startAccountOAuth("openai-codex", oauthReplacement);

    expect(request).toHaveBeenNthCalledWith(
      1,
      "http://agent.example:31337/api/accounts/openai-api",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          source: "api-key",
          label: "Primary",
          apiKey: "replacement-secret",
          replaceAccountId: "account-1",
        }),
      }),
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "http://agent.example:31337/api/accounts/openai-codex/oauth/start",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          label: "Work Codex",
          mode: "device",
          replaceAccountId: "codex-work",
        }),
      }),
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
  });
});
