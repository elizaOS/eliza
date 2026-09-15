/**
 * Verifies MCP billing tools advertise and enforce capability-specific access,
 * including a final current-session authority check before cancellation.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppContext } from "../../types/cloud-worker-env";
import { checkCookieMutationGuard } from "../auth/cookie-mutation-guard";

const requireCurrentBillingManagerSession = mock();
const requireUserOrApiKeyWithOrg = mock();
const requestCancellation = mock();
const originalFetch = globalThis.fetch;

mock.module("../auth/workers-hono-auth", () => ({
  requireAdmin: mock(),
  requireCurrentBillingManagerSession,
  requireUserOrApiKeyWithOrg,
}));

mock.module("../services/active-billing", () => ({
  activeBillingService: {
    requestCancellation,
    listActiveResources: mock(),
    listLedger: mock(),
  },
}));

mock.module("../../db/repositories", () => ({
  organizationsRepository: { findById: mock() },
}));

mock.module("../cloud-capabilities", () => ({
  executeCloudCapabilityRest: mock(),
  getCloudCapabilities: () => [
    {
      id: "billing.active_resources",
      summary: "List active resources.",
      auth: { modes: ["session", "api_key"] },
      surfaces: {
        rest: { method: "GET", path: "/api/v1/billing/resources" },
        mcp: { tool: "cloud.billing.active_resources" },
      },
    },
    {
      id: "billing.cancel_resource",
      summary: "Stop future billing.",
      auth: { modes: ["session"], organizationRoles: ["owner", "admin"] },
      surfaces: {
        rest: { method: "POST", path: "/api/v1/billing/resources/:id/cancel" },
        mcp: { tool: "cloud.billing.cancel_resource" },
      },
    },
    {
      summary: "Use platform MCP.",
      auth: { modes: ["session", "api_key", "admin"] },
      surfaces: {
        rest: { method: "POST", path: "/api/mcp" },
        mcp: { tool: "cloud.mcp.platform" },
      },
    },
    {
      summary: "Administer users.",
      auth: { modes: ["admin"], adminOnly: true },
      surfaces: {
        rest: { method: "GET", path: "/api/v1/admin/users" },
        mcp: { tool: "cloud.admin.users" },
      },
    },
  ],
  getCloudProtocolCoverage: () => [],
}));

mock.module("../services/containers", () => ({
  containersService: { listByOrganization: mock(), checkQuota: mock() },
}));

mock.module("../services/credits", () => ({
  creditsService: {
    listTransactionsByOrganization: mock(),
  },
}));

const { callPlatformCloudMcpTool, listPlatformCloudMcpTools } = await import(
  "./platform-cloud-tools"
);

const context = {
  env: {},
  req: {
    url: "https://cloud.test/api/mcp",
    header: () => undefined,
  },
} as unknown as AppContext;

beforeEach(() => {
  requireCurrentBillingManagerSession.mockReset();
  requireUserOrApiKeyWithOrg.mockReset();
  requestCancellation.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function cookieContext(): AppContext {
  const headers: Record<string, string> = {
    cookie: "steward-token-test=session-token",
    host: "cloud.test",
    origin: "https://cloud.test",
    "x-eliza-csrf": "csrf-proof",
  };
  return {
    env: {},
    req: {
      url: "https://cloud.test/api/mcp",
      header: (name: string) => headers[name.toLowerCase()],
    },
  } as unknown as AppContext;
}

describe("platform MCP billing cancellation authority", () => {
  test("discovery advertises session-only owner/admin authority", () => {
    const tool = listPlatformCloudMcpTools().find(
      (candidate) => candidate.name === "cloud.billing.cancel_resource",
    );
    expect(tool?.auth).toEqual({
      modes: ["session"],
      organizationRoles: ["owner", "admin"],
    });
    expect(tool?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["resourceId", "resourceType", "expectedLifecycleRevision", "idempotencyKey"],
      properties: {
        resourceId: { type: "string", format: "uuid" },
        resourceType: { enum: ["container", "agent_sandbox"] },
        mode: { enum: ["stop"] },
        expectedLifecycleRevision: { type: "integer", minimum: 0 },
        idempotencyKey: { type: "string", minLength: 8, maxLength: 128 },
      },
    });
    expect(tool?.access).toEqual({ effect: "mutation", authority: "billing_manager" });
    expect(
      listPlatformCloudMcpTools().find(
        (candidate) => candidate.name === "cloud.billing.active_resources",
      )?.access,
    ).toEqual({ effect: "read", authority: "member" });
  });

  test("mixed admin auth modes remain member-authorized unless adminOnly is explicit", () => {
    const tools = listPlatformCloudMcpTools();
    expect(tools.find((tool) => tool.name === "cloud.mcp.platform")?.access.authority).toBe(
      "member",
    );
    expect(tools.find((tool) => tool.name === "cloud.admin.users")?.access.authority).toBe("admin");
  });

  test("uses the current authorized tenant and rechecks before infrastructure", async () => {
    requireCurrentBillingManagerSession.mockResolvedValue({
      id: "owner-1",
      organization_id: "org-current",
      role: "owner",
      steward_id: "steward-owner",
    });
    requestCancellation.mockImplementation(async (options) => {
      expect(await options.authorizeInfrastructureMutation()).toBe("steward-owner");
      return { disposition: "accepted", receipt: { status: "accepted" } };
    });

    const result = await callPlatformCloudMcpTool(context, "cloud.billing.cancel_resource", {
      resourceId: "resource-1",
      resourceType: "agent_sandbox",
      mode: "stop",
      expectedLifecycleRevision: 7,
      idempotencyKey: "billing-cancel-request-0001",
    });

    expect(result.content[0]?.text).toContain('"status": "accepted"');
    expect(requestCancellation).toHaveBeenCalledTimes(1);
    expect(requestCancellation).toHaveBeenCalledWith({
      organizationId: "org-current",
      requestedByUserId: "owner-1",
      resourceId: "resource-1",
      resourceType: "agent_sandbox",
      expectedLifecycleRevision: 7,
      idempotencyKey: "billing-cancel-request-0001",
      triggerEnv: {},
      authorizeInfrastructureMutation: expect.any(Function),
    });
    expect(requireCurrentBillingManagerSession).toHaveBeenCalledTimes(2);
  });

  test("makes zero cancellation calls on session, role, or primary-state denial", async () => {
    for (const status of [401, 403, 503]) {
      requireCurrentBillingManagerSession.mockRejectedValueOnce(
        Object.assign(new Error("denied"), { status }),
      );
      await expect(
        callPlatformCloudMcpTool(context, "cloud.billing.cancel_resource", {
          resourceId: "resource-1",
          resourceType: "container",
          expectedLifecycleRevision: 7,
          idempotencyKey: "billing-cancel-request-0001",
        }),
      ).rejects.toThrow("denied");
    }

    expect(requestCancellation).not.toHaveBeenCalled();
  });

  test("cloud.api.request preserves cookie-session CSRF proof on its REST hop", async () => {
    requireUserOrApiKeyWithOrg.mockResolvedValue({
      id: "owner-1",
      organization_id: "org-current",
      role: "owner",
    });
    globalThis.fetch = mock(async (url, init) => {
      const requestHeaders = new Headers(init?.headers);
      const requestHost = new URL(String(url)).host;
      const verdict = checkCookieMutationGuard(
        {
          header: (name) =>
            name.toLowerCase() === "host" ? requestHost : (requestHeaders.get(name) ?? undefined),
        },
        "test",
        false,
      );
      return verdict.ok
        ? Response.json({ success: true })
        : Response.json(verdict, { status: 403 });
    }) as typeof fetch;

    const result = await callPlatformCloudMcpTool(cookieContext(), "cloud.api.request", {
      method: "POST",
      path: "/api/v1/billing/resources/resource-1/cancel",
    });

    expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({
      status: 200,
      ok: true,
    });
  });
});
