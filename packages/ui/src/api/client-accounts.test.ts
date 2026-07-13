/** Verifies the account-routing client extension's typed HTTP contract. */
import { describe, expect, it, vi } from "vitest";
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
    const fetchMock = vi.fn(async () => response);
    client.fetch = fetchMock as unknown as typeof client.fetch;

    await expect(client.putUseCaseRouting(response)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith("/api/accounts/routing", {
      method: "PUT",
      body: JSON.stringify(response),
    });
  });
});
