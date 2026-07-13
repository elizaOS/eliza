/** Verifies the account-routing client extension's typed HTTP contract. */
import { describe, expect, it } from "vitest";
import "./client-agent";
import "./client-accounts";
import { ElizaClient } from "./client-base";

describe("account client extension", () => {
  it("persists an ordered use-case routing chain", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const response = {
      useCase: "chat" as const,
      tiers: [
        { providerId: "openai-api" as const },
        { providerId: "anthropic-api" as const, accountId: "fallback" },
      ],
    };
    const requests: Array<[string, RequestInit | undefined]> = [];
    client.fetch = (async (path: string, init?: RequestInit) => {
      requests.push([path, init]);
      return response;
    }) as unknown as typeof client.fetch;

    await expect(client.putUseCaseRouting(response)).resolves.toEqual(response);
    expect(requests).toEqual([
      [
        "/api/accounts/routing",
        { method: "PUT", body: JSON.stringify(response) },
      ],
    ]);
  });
});
