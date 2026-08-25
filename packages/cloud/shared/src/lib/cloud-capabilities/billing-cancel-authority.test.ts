/**
 * Locks the capability registry and generic REST executor to the same
 * session-only OWNER/ADMIN contract as direct billing cancellation surfaces.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppContext } from "../../types/cloud-worker-env";
import { checkCookieMutationGuard } from "../auth/cookie-mutation-guard";

const requireCurrentBillingManagerSession = mock();
const originalFetch = globalThis.fetch;

mock.module("../auth/workers-hono-auth", () => ({
  requireAdmin: mock(),
  requireCurrentBillingManagerSession,
  requireUserOrApiKeyWithOrg: mock(),
}));

const { executeCloudCapabilityRest } = await import("./executor");
const { getCloudCapability, getCloudProtocolCoverage } = await import("./registry");

const context = {
  env: {},
  req: {
    url: "https://cloud.test/api/mcp",
    header: () => undefined,
  },
} as unknown as AppContext;

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

beforeEach(() => {
  requireCurrentBillingManagerSession.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("billing cancellation capability authority", () => {
  test("advertises only session OWNER/ADMIN authority", () => {
    expect(getCloudCapability("billing.cancel_resource")?.auth).toEqual({
      modes: ["session"],
      organizationRoles: ["owner", "admin"],
    });
    expect(
      getCloudProtocolCoverage().find((capability) => capability.id === "billing.cancel_resource")
        ?.organizationRoles,
    ).toEqual(["owner", "admin"]);
  });

  test("generic capability execution denies before forwarding any request", async () => {
    const forwarded = mock();
    globalThis.fetch = forwarded as typeof fetch;
    requireCurrentBillingManagerSession.mockRejectedValue(new Error("denied"));

    await expect(
      executeCloudCapabilityRest(context, "billing.cancel_resource", {
        resourceId: "resource-1",
      }),
    ).rejects.toThrow("denied");

    expect(forwarded).not.toHaveBeenCalled();
  });

  test("generic capability execution forwards only after current authorization", async () => {
    requireCurrentBillingManagerSession.mockResolvedValue({
      organization_id: "org-current",
      role: "owner",
    });
    const forwarded = mock(async () => Response.json({ success: true, resourceId: "resource-1" }));
    globalThis.fetch = forwarded as typeof fetch;

    const result = await executeCloudCapabilityRest(context, "billing.cancel_resource", {
      resourceId: "resource-1",
    });

    expect(result.response.ok).toBe(true);
    expect(forwarded).toHaveBeenCalledTimes(1);
    expect(String(forwarded.mock.calls[0]?.[0])).toContain(
      "/api/v1/billing/resources/resource-1/cancel",
    );
  });

  test("preserves cookie-session CSRF proof through the internal REST boundary", async () => {
    requireCurrentBillingManagerSession.mockResolvedValue({
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

    const result = await executeCloudCapabilityRest(cookieContext(), "billing.cancel_resource", {
      resourceId: "resource-1",
    });

    expect(result.response.status).toBe(200);
    expect(result.response.ok).toBe(true);
  });
});
