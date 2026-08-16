/**
 * Exercises the mounted analytics overview Hono route with mocked auth, rate
 * limiting, service, and logging boundaries. Unsupported time ranges must be
 * rejected before the analytics service receives them.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const supportedTimeRanges = new Set(["daily", "weekly", "monthly"]);
const getOverview = mock(async (_organizationId: string, timeRange: string) => {
  if (!supportedTimeRanges.has(timeRange)) {
    throw new TypeError(
      "Cannot read properties of undefined (reading 'getTime')",
    );
  }
  return {
    summary: {
      totalRequests: 10,
      successRate: 0.8,
      totalCost: 4,
      avgCostPerRequest: 0.4,
      totalTokens: 100,
    },
  };
});

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ error: "internal_error" }, 500),
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/services/analytics", () => ({
  analyticsService: { getOverview },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined },
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/analytics/overview", route);

function getAnalyticsOverview(query = "") {
  return app.request(`/api/analytics/overview${query}`);
}

describe("GET /api/analytics/overview timeRange validation", () => {
  beforeEach(() => getOverview.mockClear());

  test.each([
    ["", "daily"],
    ["?timeRange=", "daily"],
    ["?timeRange=daily", "daily"],
    ["?timeRange=weekly", "weekly"],
    ["?timeRange=monthly", "monthly"],
  ])("accepts %s as %s", async (query, expectedTimeRange) => {
    const response = await getAnalyticsOverview(query);

    expect(response.status).toBe(200);
    expect(getOverview).toHaveBeenCalledTimes(1);
    expect(getOverview).toHaveBeenCalledWith("org-1", expectedTimeRange);
    const body = (await response.json()) as {
      data: { timeRange: string };
    };
    expect(body.data.timeRange).toBe(expectedTimeRange);
  });

  test.each(["hourly", "week", "bogus", "daily ", "1"])(
    "rejects unsupported timeRange=%s before analytics lookup",
    async (value) => {
      const response = await getAnalyticsOverview(
        `?timeRange=${encodeURIComponent(value)}`,
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body).toEqual({ error: "Invalid timeRange" });
      expect(getOverview).not.toHaveBeenCalled();
    },
  );
});
