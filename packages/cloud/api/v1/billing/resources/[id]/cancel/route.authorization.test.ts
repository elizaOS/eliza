/**
 * Proves the billable-resource cancellation route reaches its effect only
 * after the current OWNER/ADMIN session boundary authorizes the exact tenant.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { ApiError } from "@/lib/api/cloud-worker-errors";

const requireCurrentBillingManagerSession = mock();
const cancelResource = mock();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireCurrentBillingManagerSession,
}));

mock.module("@/lib/services/active-billing", () => ({
  activeBillingService: { cancelResource },
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  moneyRateLimit:
    () =>
    async (_context: unknown, next: () => Promise<void>): Promise<void> =>
      await next(),
  RateLimitPresets: { STANDARD: {} },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), warn: mock(), info: mock(), debug: mock() },
}));

const { default: route } = await import("./route");
const app = new Hono();
app.route("/api/v1/billing/resources/:id/cancel", route);

beforeEach(() => {
  requireCurrentBillingManagerSession.mockReset();
  cancelResource.mockReset();
  cancelResource.mockResolvedValue({
    resourceId: "resource-1",
    status: "cancelled",
  });
});

describe("billing resource cancellation authorization", () => {
  test("uses the freshly authorized organization at the final effect boundary", async () => {
    cancelResource.mockImplementation(async (options) => {
      await options.authorizeInfrastructureMutation();
      return { resourceId: "resource-1", status: "cancelled" };
    });
    for (const role of ["owner", "admin"]) {
      requireCurrentBillingManagerSession.mockResolvedValue({
        id: `${role}-1`,
        organization_id: "org-current",
        role,
      });

      const response = await app.request(
        "https://api.test/api/v1/billing/resources/resource-1/cancel",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ resourceType: "container", mode: "delete" }),
        },
      );

      expect(response.status).toBe(200);
    }

    expect(cancelResource).toHaveBeenCalledTimes(2);
    expect(requireCurrentBillingManagerSession).toHaveBeenCalledTimes(4);
    expect(cancelResource).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        organizationId: "org-current",
        resourceId: "resource-1",
        resourceType: "container",
        mode: "delete",
      }),
    );
  });

  test("makes zero cancellation calls when current authority denies", async () => {
    for (const status of [401, 403, 503]) {
      requireCurrentBillingManagerSession.mockRejectedValueOnce(
        new ApiError(
          status,
          status === 401
            ? "session_auth_required"
            : status === 403
              ? "access_denied"
              : "service_unavailable",
          "denied",
        ),
      );
      const response = await app.request(
        "https://api.test/api/v1/billing/resources/resource-1/cancel",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "stop" }),
        },
      );
      expect(response.status).toBe(status);
    }

    expect(cancelResource).not.toHaveBeenCalled();
  });
});
