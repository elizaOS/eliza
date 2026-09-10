/**
 * Verifies configured platform-MCP forwarding positively classifies protocol
 * envelopes and gates every tool invocation before the real forwarding seam.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const requireCurrentBillingManagerSession = mock();
const requireUserOrApiKeyWithOrg = mock();
const requireAdmin = mock();
const forwardMcpUpstreamRequest = mock(async () =>
  Response.json({ forwarded: true }),
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireCurrentBillingManagerSession,
  requireUserOrApiKeyWithOrg,
  requireAdmin,
}));

mock.module("@/lib/mcp/mcp-upstream-forward", () => ({
  forwardMcpUpstreamRequest,
}));

mock.module("@/lib/mcp/platform-cloud-tools", () => ({
  callPlatformCloudMcpTool: mock(),
  listPlatformCloudMcpTools: () => [
    {
      name: "cloud.billing.cancel_resource",
      access: { effect: "mutation", authority: "billing_manager" },
    },
    {
      name: "cloud.billing.active_resources",
      access: { effect: "read", authority: "member" },
    },
    {
      name: "cloud.api.request",
      access: { effect: "dynamic", authority: "billing_manager" },
    },
    {
      name: "cloud.admin.request",
      access: { effect: "dynamic", authority: "admin" },
    },
  ],
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
  requireUserOrApiKeyWithOrg.mockReset();
  requireAdmin.mockReset();
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
    expect((await response.json()) as unknown).toEqual([
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

  test("does not gate protocol discovery calls", async () => {
    await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(requireCurrentBillingManagerSession).not.toHaveBeenCalled();
    expect(forwardMcpUpstreamRequest).toHaveBeenCalledTimes(1);
  });

  test("allows member and API-key read tools through the catalog", async () => {
    requireUserOrApiKeyWithOrg.mockResolvedValue({
      id: "member-1",
      organization_id: "org-1",
      role: "member",
    });
    const response = await post(
      {
        jsonrpc: "2.0",
        id: "read",
        method: "tools/call",
        params: { name: "cloud.billing.active_resources", arguments: {} },
      },
      { "x-api-key": "eliza_live_key" },
    );
    expect(response.status).toBe(200);
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(requireCurrentBillingManagerSession).not.toHaveBeenCalled();
    expect(forwardMcpUpstreamRequest).toHaveBeenCalledTimes(1);
  });

  test("allows member generic reads but preserves admin authority for admin reads", async () => {
    requireUserOrApiKeyWithOrg.mockResolvedValue({
      id: "member-1",
      organization_id: "org-1",
      role: "member",
    });
    requireAdmin.mockResolvedValue({
      user: { id: "admin-1" },
      role: "super_admin",
    });

    await post({
      jsonrpc: "2.0",
      id: "generic-read",
      method: "tools/call",
      params: {
        name: "cloud.api.request",
        arguments: { method: "GET", path: "/api/v1/containers" },
      },
    });
    await post({
      jsonrpc: "2.0",
      id: "admin-read",
      method: "tools/call",
      params: {
        name: "cloud.admin.request",
        arguments: { method: "GET", path: "/api/admin/test" },
      },
    });

    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(requireAdmin).toHaveBeenCalledTimes(1);
    expect(requireCurrentBillingManagerSession).not.toHaveBeenCalled();
    expect(forwardMcpUpstreamRequest).toHaveBeenCalledTimes(2);
  });

  test("a method override cannot disguise a mutation as a catalogued read", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: "override",
      method: "tools/call",
      params: {
        name: "cloud.billing.active_resources",
        arguments: { params: { method: "POST" } },
      },
    });
    expect(response.status).toBe(400);
    expect(requireCurrentBillingManagerSession).not.toHaveBeenCalled();
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(forwardMcpUpstreamRequest).not.toHaveBeenCalled();
  });

  test("uses admin authority for catalogued admin mutations", async () => {
    requireAdmin.mockResolvedValue({
      user: { id: "admin-1" },
      role: "super_admin",
    });
    await post({
      jsonrpc: "2.0",
      id: "admin",
      method: "tools/call",
      params: {
        name: "cloud.admin.request",
        arguments: { method: "POST", path: "/api/admin/test" },
      },
    });
    expect(requireAdmin).toHaveBeenCalledTimes(1);
    expect(requireCurrentBillingManagerSession).not.toHaveBeenCalled();
    expect(forwardMcpUpstreamRequest).toHaveBeenCalledTimes(1);
  });

  test("requires every distinct authority represented in a mixed batch", async () => {
    requireAdmin.mockResolvedValue({
      user: { id: "admin-1" },
      role: "super_admin",
    });
    requireCurrentBillingManagerSession.mockRejectedValue(
      Object.assign(
        new Error("A current billing-manager session is required"),
        {
          status: 401,
        },
      ),
    );

    const response = await post([
      {
        jsonrpc: "2.0",
        id: "admin",
        method: "tools/call",
        params: {
          name: "cloud.admin.request",
          arguments: { method: "POST", path: "/api/admin/test" },
        },
      },
      {
        jsonrpc: "2.0",
        id: "billing",
        method: "tools/call",
        params: {
          name: "cloud.billing.cancel_resource",
          arguments: { resourceId: "r-1" },
        },
      },
    ]);

    expect(response.status).toBe(200);
    expect(requireAdmin).toHaveBeenCalledTimes(1);
    expect(requireCurrentBillingManagerSession).toHaveBeenCalledTimes(1);
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    const payload: unknown = await response.json();
    expect(payload).toEqual([
      expect.objectContaining({
        id: "admin",
        error: expect.objectContaining({ code: -32000 }),
      }),
      expect.objectContaining({
        id: "billing",
        error: expect.objectContaining({ code: -32000 }),
      }),
    ]);
    expect(forwardMcpUpstreamRequest).not.toHaveBeenCalled();
  });

  test("denies unknown, versioned, and alternate-shape tool vocabulary", async () => {
    for (const request of [
      {
        jsonrpc: "2.0",
        id: "renamed",
        method: "tools/call",
        params: {
          name: "vendor.billing.stop.v9",
          arguments: { target: "r-1" },
        },
      },
      {
        jsonrpc: "2.0",
        id: "encoded",
        method: "tools/call",
        params: { name: "anything", payload: "%252Fbilling%252Fcancel" },
      },
      {
        jsonrpc: "2.0",
        id: "empty-args",
        method: "tools/call",
        params: { name: "read-looking-tool" },
      },
    ]) {
      const response = await post(request);
      expect(response.status).toBe(400);
    }

    expect(requireCurrentBillingManagerSession).not.toHaveBeenCalled();
    expect(forwardMcpUpstreamRequest).not.toHaveBeenCalled();
  });

  test("rejects unknown protocol methods instead of forwarding by default", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: "future-mutation",
      method: "vendor/mutate",
      params: { operation: "cancel" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      id: "future-mutation",
      error: { code: -32601 },
    });
    expect(requireCurrentBillingManagerSession).not.toHaveBeenCalled();
    expect(forwardMcpUpstreamRequest).not.toHaveBeenCalled();
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

  test("gates catalogued direct and generic cancellation and rejects an unknown alias", async () => {
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

    expect(requireCurrentBillingManagerSession).toHaveBeenCalledTimes(2);
    expect(forwardMcpUpstreamRequest).not.toHaveBeenCalled();
  });
});
