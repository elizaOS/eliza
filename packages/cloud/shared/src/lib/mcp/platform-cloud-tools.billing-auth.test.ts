/**
 * Verifies MCP billable-resource cancellation cannot reach the service unless
 * the final current-session OWNER/ADMIN authority gate succeeds.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppContext } from "../../types/cloud-worker-env";
import { checkCookieMutationGuard } from "../auth/cookie-mutation-guard";

const requireCurrentBillingManagerSession = mock();
const requireUserOrApiKeyWithOrg = mock();
const cancelResource = mock();
const originalFetch = globalThis.fetch;

mock.module("../auth/workers-hono-auth", () => ({
  requireAdmin: mock(),
  requireCurrentBillingManagerSession,
  requireUserOrApiKeyWithOrg,
}));

mock.module("../services/active-billing", () => ({
  activeBillingService: {
    cancelResource,
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
      summary: "Stop future billing.",
      auth: { modes: ["session"], organizationRoles: ["owner", "admin"] },
      surfaces: {
        rest: { method: "POST", path: "/api/v1/billing/resources/:id/cancel" },
        mcp: { tool: "cloud.billing.cancel_resource" },
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
  cancelResource.mockReset();
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
  });

  test("uses the current authorized tenant and rechecks before infrastructure", async () => {
    requireCurrentBillingManagerSession.mockResolvedValue({
      id: "owner-1",
      organization_id: "org-current",
      role: "owner",
    });
    cancelResource.mockImplementation(async (options) => {
      await options.authorizeInfrastructureMutation();
      return { status: "cancelled" };
    });

    const result = await callPlatformCloudMcpTool(context, "cloud.billing.cancel_resource", {
      resourceId: "resource-1",
      resourceType: "agent_sandbox",
      mode: "delete",
    });

    expect(result.content[0]?.text).toContain('"status": "cancelled"');
    expect(cancelResource).toHaveBeenCalledTimes(1);
    expect(cancelResource).toHaveBeenCalledWith({
      organizationId: "org-current",
      resourceId: "resource-1",
      resourceType: "agent_sandbox",
      mode: "delete",
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
        }),
      ).rejects.toThrow("denied");
    }

    expect(cancelResource).not.toHaveBeenCalled();
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
