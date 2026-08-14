/**
 * Verifies that account-native Shared identity resolution uses the read-only
 * personal endpoint and returns the standard per-agent chat base.
 */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { ElizaClient } from "./client-base";
import "./client-cloud";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getPersonalSharedEliza", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves the rowless identity without creating an agent", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(200, {
          success: true,
          data: {
            identity: {
              id: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
              displayName: "Eliza",
              runtime: "shared",
            },
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ElizaClient().getPersonalSharedEliza({
      cloudApiBase: "https://api.eliza.app",
      authToken: "steward-token",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.eliza.app/api/v1/eliza/personal",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: "Bearer steward-token",
      },
    });
    expect(result).toEqual({
      agentId: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      agentName: "Eliza",
      apiBase:
        "https://api.eliza.app/api/v1/eliza/agents/personal%3A3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
    });
  });

  it("rejects a response that does not identify the personal Shared runtime", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          success: true,
          data: {
            identity: {
              id: "sandbox-row-id",
              displayName: "Eliza",
              runtime: "shared",
            },
          },
        }),
      ),
    );

    await expect(
      new ElizaClient().getPersonalSharedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
      }),
    ).rejects.toThrow("invalid personal Shared identity");
  });
});
