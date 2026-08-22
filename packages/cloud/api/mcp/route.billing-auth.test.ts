/**
 * Verifies configured platform-MCP forwarding cannot bypass final billing
 * cancellation authority, including requests embedded in JSON-RPC batches.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const requireCurrentBillingManagerSession = mock();
const forwardMcpUpstreamRequest = mock(async () =>
  Response.json({ forwarded: true }),
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireCurrentBillingManagerSession,
}));

mock.module("@/lib/mcp/mcp-upstream-forward", () => ({
  forwardMcpUpstreamRequest,
}));

mock.module("@/lib/mcp/platform-cloud-tools", () => ({
  callPlatformCloudMcpTool: mock(),
  listPlatformCloudMcpTools: () => [],
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock() },
}));

const route = (await import("./route")).default;
const env = {
  ELIZA_CLOUD_PLATFORM_MCP_UPSTREAM_URL: "https://mcp.example.test/platform",
};

beforeEach(() => {
  requireCurrentBillingManagerSession.mockReset();
  forwardMcpUpstreamRequest.mockClear();
});

function post(body: unknown, headers: Record<string, string> = {}, path = "/") {
  return route.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("configured platform MCP billing cancellation authority", () => {
  test("denies a privileged API-key call before any upstream request", async () => {
    requireCurrentBillingManagerSession.mockRejectedValue(
      Object.assign(new Error("A signed-in user session is required"), {
        status: 401,
      }),
    );

    const response = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cloud.billing.cancel_resource",
          arguments: { resourceId: "r-1" },
        },
      },
      { "x-api-key": "eliza_live_key" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: 1,
      error: { code: -32000 },
    });
    expect(forwardMcpUpstreamRequest).not.toHaveBeenCalled();
  });

  test("rejects an entire mixed batch when current authority is stale", async () => {
    requireCurrentBillingManagerSession.mockRejectedValue(
      Object.assign(
        new Error(
          "Only organization owners and admins can cancel billable resources",
        ),
        {
          status: 403,
        },
      ),
    );

    const response = await post([
      { jsonrpc: "2.0", id: "list", method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: "cancel",
        method: "tools/call",
        params: {
          name: "cloud.billing.cancel_resource",
          arguments: { resourceId: "r-1" },
        },
      },
    ]);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({
        id: "list",
        error: expect.objectContaining({ code: -32000 }),
      }),
      expect.objectContaining({
        id: "cancel",
        error: expect.objectContaining({ code: -32000 }),
      }),
    ]);
    expect(forwardMcpUpstreamRequest).not.toHaveBeenCalled();
  });

  test("also gates generic API-tool cancellation requests", async () => {
    requireCurrentBillingManagerSession.mockRejectedValue(
      Object.assign(new Error("A signed-in user session is required"), {
        status: 401,
      }),
    );

    for (const [method, path] of [
      ["post", "/api/v1/billing/resources/r-1/cancel?mode=delete"],
      ["POST", "/api/v1/billing/resources/r-1/../r-1/cancel"],
      ["POST", "/api/v1/billing/resources/r-1/%2e%2e/r-1/cancel"],
    ]) {
      await post(
        {
          jsonrpc: "2.0",
          id: "generic-cancel",
          method: "tools/call",
          params: {
            name: "cloud.api.request",
            arguments: { method, path },
          },
        },
        { "x-api-key": "eliza_live_key" },
      );
    }

    expect(requireCurrentBillingManagerSession).toHaveBeenCalledTimes(3);
    expect(forwardMcpUpstreamRequest).not.toHaveBeenCalled();
  });

  test("forwards only after current owner or admin authority succeeds", async () => {
    requireCurrentBillingManagerSession.mockResolvedValue({
      id: "owner-1",
      organization_id: "org-1",
      role: "owner",
    });

    const response = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "cloud.billing.cancel_resource",
        arguments: { resourceId: "r-1" },
      },
    });

    expect(response.status).toBe(200);
    expect(requireCurrentBillingManagerSession).toHaveBeenCalledTimes(1);
    expect(forwardMcpUpstreamRequest).toHaveBeenCalledTimes(1);
  });

  test("does not gate unrelated upstream MCP calls", async () => {
    await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(requireCurrentBillingManagerSession).not.toHaveBeenCalled();
    expect(forwardMcpUpstreamRequest).toHaveBeenCalledTimes(1);
  });

  test("fails closed without forwarding malformed upstream JSON", async () => {
    const response = await route.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: -32700, message: "Invalid JSON" },
    });
    expect(requireCurrentBillingManagerSession).not.toHaveBeenCalled();
    expect(forwardMcpUpstreamRequest).not.toHaveBeenCalled();
  });

  test("gates direct, alias, and generic cancellation on non-root upstream paths", async () => {
    requireCurrentBillingManagerSession.mockRejectedValue(
      Object.assign(new Error("A signed-in user session is required"), {
        status: 401,
      }),
    );

    for (const [name, args] of [
      ["cloud.billing.cancel_resource", { resourceId: "r-1" }],
      ["billing.cancel_resource", { resourceId: "r-1" }],
      [
        "cloud.api.request",
        { method: "POST", path: "/api/v1/billing/resources/r-1/cancel" },
      ],
    ] as const) {
      await post(
        {
          jsonrpc: "2.0",
          id: name,
          method: "tools/call",
          params: { name, arguments: args },
        },
        { "x-api-key": "eliza_live_key" },
        "/alternate",
      );
    }

    expect(requireCurrentBillingManagerSession).toHaveBeenCalledTimes(3);
    expect(forwardMcpUpstreamRequest).not.toHaveBeenCalled();
  });
});
