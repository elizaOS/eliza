/** Unit tests for `ElizaCloudClient`'s apps (Eliza Cloud Apps) methods, asserting route/verb/body against a recording mock fetch. */

import { describe, expect, it } from "vitest";
import { ElizaCloudClient } from "./client.js";

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

function createClientRecorder(
  responseBody: Record<string, unknown> = { success: true },
) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input, init = {}) => {
    const headers = new Headers(init.headers);
    requests.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body:
        typeof init.body === "string" && init.body.length > 0
          ? JSON.parse(init.body)
          : undefined,
    });

    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return {
    requests,
    client: new ElizaCloudClient({
      baseUrl: "https://cloud.test",
      apiKey: "eliza_test_key",
      fetchImpl,
    }),
  };
}

describe("ElizaCloudClient typed app methods", () => {
  it("listApps GETs /api/v1/apps and returns a typed ListAppsResponse", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      apps: [],
    });
    const res = await client.listApps();
    // Compile-time proof the result is typed, not `unknown`: `res.apps` is
    // AppDto[] (Array.isArray would not type-check on `unknown`).
    expect(Array.isArray(res.apps)).toBe(true);
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps",
      method: "GET",
    });
  });

  it("getApp GETs /api/v1/apps/:id with the id encoded into the path", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      app: { id: "app_1" },
    });
    const res = await client.getApp("app_1");
    expect(res.app.id).toBe("app_1");
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/app_1",
      method: "GET",
    });
  });

  it("createApp POSTs /api/v1/apps with the snake_case create body", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      app: { id: "app_1" },
      apiKey: "eliza_app_secret",
    });
    const res = await client.createApp({
      name: "My App",
      app_url: "https://my.app",
      is_active: false,
      monetization_enabled: true,
      inference_markup_percentage: 20,
    });
    expect(res.apiKey).toBe("eliza_app_secret");
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps",
      method: "POST",
      body: {
        name: "My App",
        app_url: "https://my.app",
        is_active: false,
        monetization_enabled: true,
        inference_markup_percentage: 20,
      },
    });
  });

  it("updateApp PATCHes /api/v1/apps/:id with the patch body", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      app: { id: "app_1" },
    });
    await client.updateApp("app_1", { name: "Renamed", is_active: false });
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/app_1",
      method: "PATCH",
      body: { name: "Renamed", is_active: false },
    });
  });

  it("updateMonetization PUTs /api/v1/apps/:id/monetization with camelCase settings", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      monetization: {
        monetizationEnabled: true,
        inferenceMarkupPercentage: 20,
        purchaseSharePercentage: 10,
        platformOffsetAmount: 0,
        totalCreatorEarnings: 0,
      },
    });
    const res = await client.updateMonetization("app_1", {
      monetizationEnabled: true,
      inferenceMarkupPercentage: 20,
      purchaseSharePercentage: 10,
    });
    expect(res.monetization?.monetizationEnabled).toBe(true);
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/app_1/monetization",
      method: "PUT",
      body: {
        monetizationEnabled: true,
        inferenceMarkupPercentage: 20,
        purchaseSharePercentage: 10,
      },
    });
  });

  it("deployApp POSTs /api/v1/apps/:id/deploy (empty body by default)", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      deploymentId: "dep_1",
      status: "building",
      startedAt: "2026-06-29T00:00:00.000Z",
    });
    const res = await client.deployApp("app_1");
    expect(res.deploymentId).toBe("dep_1");
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/app_1/deploy",
      method: "POST",
      body: {},
    });
  });

  it("deployAppFrontend POSTs /api/v1/apps/:id/frontend with the bundle", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      deployment: {
        id: "dep_fe_1",
        version: 1,
        status: "active",
        file_count: 2,
      },
      public_url: "https://my-project.frontends.test",
    });
    const res = await client.deployAppFrontend("app_1", {
      files: [{ path: "index.html", content: "<html></html>" }],
      buildMeta: { source: "agent" },
    });
    expect(res.deployment.id).toBe("dep_fe_1");
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/app_1/frontend",
      method: "POST",
      body: {
        files: [{ path: "index.html", content: "<html></html>" }],
        buildMeta: { source: "agent" },
      },
    });
  });

  it("listAppFrontendDeployments GETs /api/v1/apps/:id/frontend", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      active_deployment_id: "dep_fe_1",
      public_url: "https://my-project.frontends.test",
      deployments: [],
    });
    const res = await client.listAppFrontendDeployments("app_1");
    expect(res.active_deployment_id).toBe("dep_fe_1");
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/app_1/frontend",
      method: "GET",
    });
  });

  it("activateAppFrontend POSTs /api/v1/apps/:id/frontend/:deploymentId/activate", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      deployment: { id: "dep_fe_2", version: 2, status: "active" },
      public_url: "https://my-project.frontends.test",
    });
    const res = await client.activateAppFrontend("app_1", "dep_fe_2");
    expect(res.deployment.id).toBe("dep_fe_2");
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/app_1/frontend/dep_fe_2/activate",
      method: "POST",
    });
  });

  it("getAppDeployStatus GETs /api/v1/apps/:id/deploy/status", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      deploymentId: "dep_1",
      status: "DEPLOYED",
      vercelUrl: null,
      error: null,
      startedAt: null,
    });
    const res = await client.getAppDeployStatus("app_1");
    expect(res.status).toBe("DEPLOYED");
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/app_1/deploy/status",
      method: "GET",
    });
  });

  it("getAppAnalytics GETs the typed app analytics window", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      analytics: [
        {
          period_start: "2026-07-23T00:00:00.000Z",
          total_requests: 12,
          unique_users: 4,
          new_users: 0,
          total_cost: "1.25",
        },
      ],
      totalStats: {
        totalRequests: 12,
        totalUsers: 4,
        totalCreditsUsed: "1.25",
      },
      period: {
        type: "daily",
        start: "2026-07-01T00:00:00.000Z",
        end: "2026-07-23T00:00:00.000Z",
      },
    });

    const res = await client.getAppAnalytics("app_1", {
      period: "daily",
      startDate: "2026-07-01T00:00:00.000Z",
      endDate: "2026-07-23T00:00:00.000Z",
    });

    expect(res.totalStats.totalRequests).toBe(12);
    expect(res.analytics[0]?.unique_users).toBe(4);
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/app_1/analytics?period=daily&start_date=2026-07-01T00%3A00%3A00.000Z&end_date=2026-07-23T00%3A00%3A00.000Z",
      method: "GET",
    });
  });

  it("listAppUsers GETs the typed app user list with a limit", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      users: [
        {
          id: "app-user-1",
          app_id: "app_1",
          user_id: "user_1",
          signup_source: "chat",
          referral_code_used: null,
          ip_address: null,
          user_agent: null,
          total_requests: 3,
          total_credits_used: "0.25",
          first_seen_at: "2026-07-22T00:00:00.000Z",
          last_seen_at: "2026-07-23T00:00:00.000Z",
          metadata: {},
        },
      ],
      pagination: { total: 1, limit: 25 },
    });

    const res = await client.listAppUsers("app_1", { limit: 25 });

    expect(res.users[0]?.total_requests).toBe(3);
    expect(res.pagination).toEqual({ total: 1, limit: 25 });
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/app_1/users?limit=25",
      method: "GET",
    });
  });

  it("getAppDeployStatus + getApp thread a per-request AbortSignal into fetch (deploy-gate poll timeout)", async () => {
    const seenSignals: Array<AbortSignal | null | undefined> = [];
    const fetchImpl = (async (_input, init = {}) => {
      seenSignals.push(init.signal);
      return new Response(JSON.stringify({ success: true, app: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = new ElizaCloudClient({
      baseUrl: "https://cloud.test",
      apiKey: "eliza_test_key",
      fetchImpl,
    });

    const controller = new AbortController();
    await client.getAppDeployStatus("app_1", { signal: controller.signal });
    await client.getApp("app_1", { signal: controller.signal });

    expect(seenSignals).toHaveLength(2);
    expect(seenSignals[0]).toBe(controller.signal);
    expect(seenSignals[1]).toBe(controller.signal);
  });

  it("deleteApp DELETEs /api/v1/apps/:id", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      message: "deleted",
    });
    const res = await client.deleteApp("app_1");
    expect(res.message).toBe("deleted");
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/app_1",
      method: "DELETE",
    });
  });

  it("regenerateAppApiKey POSTs /api/v1/apps/:id/regenerate-api-key and returns the new key", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      apiKey: "eliza_app_rotated_secret",
      message:
        "API key regenerated successfully. Make sure to save it securely.",
    });
    const res = await client.regenerateAppApiKey("app_1");
    expect(res.apiKey).toBe("eliza_app_rotated_secret");
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/app_1/regenerate-api-key",
      method: "POST",
    });
  });

  it("buyAppDomain POSTs /api/v1/apps/:id/domains/buy and returns the typed purchase envelope", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      domain: "example.com",
      appDomainId: "ad_1",
      zoneId: null,
      status: "pending",
      verified: false,
      expiresAt: "2027-07-01T00:00:00.000Z",
      pendingZoneProvisioning: true,
      debited: { totalUsdCents: 1399, currency: "USD" },
    });
    const res = await client.buyAppDomain("app_1", { domain: "example.com" });
    expect(res.pendingZoneProvisioning).toBe(true);
    expect(res.debited?.totalUsdCents).toBe(1399);
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/app_1/domains/buy",
      method: "POST",
      body: { domain: "example.com" },
    });
  });

  it("checkAppDomain POSTs /api/v1/apps/:id/domains/check and returns the typed quote", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      domain: "example.com",
      available: true,
      currency: "USD",
      years: 1,
      price: {
        wholesaleUsdCents: 1029,
        marginUsdCents: 370,
        totalUsdCents: 1399,
        marginBps: 3600,
      },
      renewal: { totalUsdCents: 1399 },
    });
    const res = await client.checkAppDomain("app_1", {
      domain: "example.com",
    });
    expect(res.available).toBe(true);
    expect(res.price?.totalUsdCents).toBe(1399);
    expect(res.renewal?.totalUsdCents).toBe(1399);
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/app_1/domains/check",
      method: "POST",
      body: { domain: "example.com" },
    });
  });

  it("listAppDomains GETs /api/v1/apps/:id/domains and returns typed rows", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      domains: [
        {
          id: "ad_1",
          domain: "example.com",
          registrar: "cloudflare",
          status: "active",
          verified: true,
          sslStatus: "active",
          expiresAt: "2027-07-01T00:00:00.000Z",
          cloudflareZoneId: "zone_1",
          verificationToken: null,
        },
      ],
    });
    const res = await client.listAppDomains("app_1");
    expect(Array.isArray(res.domains)).toBe(true);
    expect(res.domains[0]?.sslStatus).toBe("active");
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/app_1/domains",
      method: "GET",
    });
  });

  it("getAppDomainStatus POSTs /api/v1/apps/:id/domains/status and returns the live registrar view", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      domain: "example.com",
      registrar: "cloudflare",
      status: "active",
      verified: true,
      sslStatus: "active",
      expiresAt: "2027-07-01T00:00:00.000Z",
      live: { status: "active", completedAt: null, failureReason: null },
    });
    const res = await client.getAppDomainStatus("app_1", {
      domain: "example.com",
    });
    expect(res.live?.status).toBe("active");
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/app_1/domains/status",
      method: "POST",
      body: { domain: "example.com" },
    });
  });

  it("searchDomains POSTs the read-only organization domain query", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      query: "habit",
      candidates: [
        {
          domain: "habit.tools",
          available: true,
          currency: "USD",
          years: 1,
          price: {
            wholesaleUsdCents: 1000,
            marginUsdCents: 360,
            totalUsdCents: 1360,
            marginBps: 3600,
          },
        },
      ],
    });
    const result = await client.searchDomains({ query: "habit", limit: 5 });
    expect(result.candidates[0]?.price?.totalUsdCents).toBe(1360);
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/domains/search",
      method: "POST",
      body: { query: "habit", limit: 5 },
    });
  });

  it("listManagedDomains GETs the organization domain inventory", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      domains: [
        {
          id: "domain_1",
          domain: "habit.tools",
          registrar: "cloudflare",
          status: "active",
          verified: true,
          sslStatus: "active",
          expiresAt: "2027-07-23T00:00:00.000Z",
          autoRenew: true,
          resourceType: "app",
          appId: "app_1",
          containerId: null,
          agentId: null,
          mcpId: null,
          cloudflareZoneId: "zone_1",
        },
      ],
    });
    const result = await client.listManagedDomains();
    expect(result.domains[0]?.resourceType).toBe("app");
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/domains",
      method: "GET",
    });
  });

  it("listAppDomainDnsRecords GETs the encoded app-domain DNS path", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      domain: "habit.tools",
      records: [
        {
          id: "dns_1",
          type: "A",
          name: "habit.tools",
          content: "192.0.2.10",
          ttl: 1,
          proxied: true,
        },
      ],
    });
    const result = await client.listAppDomainDnsRecords("app_1", "habit.tools");
    expect(result.records[0]?.content).toBe("192.0.2.10");
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/app_1/domains/habit.tools/dns",
      method: "GET",
    });
  });
});
