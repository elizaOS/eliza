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

  it("buyAppDomain (deferred stub) POSTs /api/v1/apps/:id/domains/buy with { domain }", async () => {
    const { client, requests } = createClientRecorder({
      success: true,
      domain: "example.com",
    });
    const res = await client.buyAppDomain("app_1", { domain: "example.com" });
    expect(res.success).toBe(true);
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/apps/app_1/domains/buy",
      method: "POST",
      body: { domain: "example.com" },
    });
  });
});
