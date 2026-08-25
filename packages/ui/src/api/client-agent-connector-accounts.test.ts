/** Verifies connector-account transport normalization against canonical server payloads. */

import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client";

function clientReturning(body: unknown): ElizaClient {
  const client = new ElizaClient("http://agent.example:31337", "token");
  client.setRequestTransport({
    request: vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  });
  return client;
}

describe("connector-account OAuth response normalization", () => {
  it("accepts the agent's canonical nested OAuth flow response", async () => {
    const result = await clientReturning({
      provider: "google-workspace",
      flow: {
        id: "flow-1",
        provider: "google-workspace",
        status: "pending",
        authUrl: "https://accounts.google.example/authorize",
      },
    }).startConnectorAccountOAuth("google-workspace", undefined);

    expect(result).toMatchObject({
      ok: true,
      authUrl: "https://accounts.google.example/authorize",
      status: "pending",
    });
  });

  it("does not turn a nested flow error into success", async () => {
    const result = await clientReturning({
      provider: "google-workspace",
      flow: {
        id: "flow-1",
        status: "error",
        authUrl: "https://accounts.google.example/authorize",
        error: "OAuth setup failed",
      },
    }).startConnectorAccountOAuth("google-workspace", undefined);

    expect(result).toMatchObject({
      ok: false,
      error: "OAuth setup failed",
    });
  });

  it("preserves an explicit rejected result even when it carries a URL", async () => {
    const result = await clientReturning({
      ok: false,
      authUrl: "https://accounts.google.example/authorize",
      error: "Authorization rejected",
    }).startConnectorAccountOAuth("google-workspace", undefined);

    expect(result).toMatchObject({
      ok: false,
      error: "Authorization rejected",
    });
  });
});
