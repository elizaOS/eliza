// @vitest-environment jsdom

/**
 * Unit coverage for the direct-cloud (Steward-session) branch of the
 * account/agent-management prototype methods that all funnel through
 * `directCloudRequest` against a Steward-authenticated client bound to a
 * known cloud API host: status, credits, API-key inventory, billing summary,
 * and the compat-agent update/delete/provision mutations. Each method's
 * proxy-fallback branch (no direct base / no token) is covered by its own
 * existing suite elsewhere; this file targets the direct-request success and
 * auth-rejected paths that the PR's changed test files did not reach.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { ElizaClient } from "./client-base";
// Side-effect import: patches the direct-cloud methods onto the prototype.
import "./client-cloud";

const CLOUD_API_BASE = "https://api.elizacloud.ai";
const STEWARD_TOKEN_KEY = "steward_session_token";

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function routeFetch(
  routes: Record<string, (input: string) => Response | Promise<Response>>,
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler(url);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe("direct-cloud prototype methods (Steward session bound)", () => {
  let client: ElizaClient;

  beforeEach(() => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "steward-jwt");
    client = new ElizaClient();
    client.setBaseUrl(CLOUD_API_BASE);
  });

  afterEach(() => {
    localStorage.removeItem(STEWARD_TOKEN_KEY);
    vi.unstubAllGlobals();
  });

  it("getCloudStatus: reports connected with the user id/org from /api/v1/user", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/api/v1/user": () =>
          jsonResponse(200, { id: "user-1", organization_id: "org-1" }),
      }),
    );
    const status = await client.getCloudStatus();
    expect(status).toMatchObject({
      connected: true,
      hasApiKey: true,
      userId: "user-1",
      organizationId: "org-1",
    });
  });

  it("getCloudStatus: reports auth-rejected on a 401", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/api/v1/user": () => jsonResponse(401, { error: "unauthorized" }),
      }),
    );
    const status = await client.getCloudStatus();
    expect(status).toMatchObject({ connected: false, reason: "auth-rejected" });
  });

  it("getCloudStatus: reports not-authenticated with no stored token", async () => {
    localStorage.removeItem(STEWARD_TOKEN_KEY);
    const status = await client.getCloudStatus();
    expect(status).toMatchObject({
      connected: false,
      reason: "not-authenticated",
    });
  });

  it("getCloudCredits: returns the numeric balance and low/critical flags", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/api/v1/credits/balance": () => jsonResponse(200, { balance: 0.25 }),
      }),
    );
    const credits = await client.getCloudCredits();
    expect(credits).toMatchObject({
      connected: true,
      balance: 0.25,
      low: true,
      critical: true,
    });
  });

  it("getCloudCredits: reports authRejected on a 401", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/api/v1/credits/balance": () =>
          jsonResponse(401, { error: "unauthorized" }),
      }),
    );
    const credits = await client.getCloudCredits();
    expect(credits).toMatchObject({ connected: false, authRejected: true });
  });

  it("listCloudApiKeys: maps raw key rows, skipping malformed entries", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/api/v1/api-keys": () =>
          jsonResponse(200, {
            keys: [
              { id: "k1", name: "Key 1", key_prefix: "sk_1", created_at: "t1" },
              { id: "", name: "no id" },
              "not-an-object",
            ],
          }),
      }),
    );
    const result = await client.listCloudApiKeys();
    expect(result.keys).toEqual([
      { id: "k1", name: "Key 1", keyPrefix: "sk_1", createdAt: "t1" },
    ]);
  });

  it("listCloudApiKeys: reports session-required on a 401", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/api/v1/api-keys": () => jsonResponse(401, { error: "unauthorized" }),
      }),
    );
    const result = await client.listCloudApiKeys();
    expect(result.reason).toBe("session-required");
    expect(result.keys).toBeNull();
  });

  it("getCloudBillingSummary: derives balance/currency/cryptoEnabled from the direct payload", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/api/v1/credits/summary": () =>
          jsonResponse(200, {
            organization: { creditBalance: 12.5 },
            pricing: { x402Enabled: true },
          }),
      }),
    );
    const summary = await client.getCloudBillingSummary();
    expect(summary).toMatchObject({
      balance: 12.5,
      currency: "USD",
      cryptoEnabled: true,
      hostedCheckoutEnabled: true,
    });
  });

  it("updateCloudCompatAgent: normalizes a successful direct PATCH response", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/api/v1/eliza/agents/agent-1": () =>
          jsonResponse(200, {
            success: true,
            data: { agentId: "agent-1", agentName: "Renamed" },
          }),
      }),
    );
    const result = await client.updateCloudCompatAgent("agent-1", {
      agentName: "Renamed",
    });
    expect(result).toEqual({
      success: true,
      data: { agentId: "agent-1", agentName: "Renamed" },
    });
  });

  it("deleteCloudCompatAgent: normalizes an async (jobId) delete response", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/api/v1/eliza/agents/agent-1": () =>
          jsonResponse(202, { success: true, data: { jobId: "job-1" } }),
      }),
    );
    const result = await client.deleteCloudCompatAgent("agent-1");
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      jobId: "job-1",
      status: "deleted",
    });
  });

  it("provisionCloudCompatAgent: normalizes a direct provision response", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/provision": () =>
          jsonResponse(200, {
            success: true,
            data: { agentId: "agent-1", status: "provisioning" },
          }),
      }),
    );
    const result = await client.provisionCloudCompatAgent("agent-1");
    expect(result.success).toBe(true);
    expect(result.data?.agentId).toBe("agent-1");
  });
});
