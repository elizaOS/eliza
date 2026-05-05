import { ElizaClient } from "@elizaos/app-core/api/client-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./client-lifeops.js";

const originalFetch = globalThis.fetch;
const fetchMock = vi.fn();

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ElizaClient LifeOps health connector methods", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("requests health connector statuses with mode and side query params", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const client = new ElizaClient({ baseUrl: "http://127.0.0.1:31337" });

    const result = await client.getHealthLifeOpsConnectorStatuses(
      "local",
      "owner",
    );

    expect(result).toEqual([]);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(
      /\/api\/lifeops\/connectors\/health\/status\?mode=local&side=owner$/,
    );
  });

  it("posts health connector starts to the provider-specific route", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        provider: "fitbit",
        side: "owner",
        mode: "local",
        requestedCapabilities: ["health.activity.read"],
        redirectUri: "http://127.0.0.1:31337/callback",
        authUrl: "https://www.fitbit.com/oauth2/authorize?state=test",
      }),
    );
    const client = new ElizaClient({ baseUrl: "http://127.0.0.1:31337" });

    await client.startHealthLifeOpsConnector("fitbit", {
      side: "owner",
      mode: "local",
      capabilities: ["health.activity.read"],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/lifeops\/connectors\/health\/fitbit\/start$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      side: "owner",
      mode: "local",
      capabilities: ["health.activity.read"],
    });
  });

  it("serializes health summary requests as query strings", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        providers: [],
        summaries: [],
        samples: [],
        workouts: [],
        sleepEpisodes: [],
        syncedAt: "2026-04-20T12:00:00.000Z",
      }),
    );
    const client = new ElizaClient({ baseUrl: "http://127.0.0.1:31337" });

    await client.getLifeOpsHealthSummary({
      provider: "oura",
      side: "owner",
      mode: "local",
      days: 14,
      startDate: "2026-04-07",
      endDate: "2026-04-20",
      forceSync: true,
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(
      /\/api\/lifeops\/health\/summary\?provider=oura&mode=local&side=owner&days=14&startDate=2026-04-07&endDate=2026-04-20&forceSync=true$/,
    );
  });
});
