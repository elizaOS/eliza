/** Verifies linked-account response and mutation contracts at the transport boundary. */
import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client";

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
            chat: { available: true },
            codingAgent: { available: true },
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

  it.each([
    ["the legacy walkthrough shape", { accounts: [] }, "response.providers"],
    ["a non-array provider list", { providers: {} }, "response.providers"],
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
    ],
  ])("rejects %s", async (_label, body, path) => {
    await expect(accountsClient(body).listAccounts()).rejects.toThrow(path);
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
