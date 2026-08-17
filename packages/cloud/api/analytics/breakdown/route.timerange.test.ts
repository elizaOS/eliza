/**
 * GET /api/analytics/breakdown `timeRange` is analytics-breakdown window
 * identity, not leftover tax on admin metrics timeRange (7d/30d/90d),
 * app-analytics period grain, analytics projections periods, analytics
 * requests view, or analytics export type. Stock develop fell unknown
 * tokens through to weekly, so `timeRange=MONTHLY` / `DAILY` silently
 * charted a week instead of a month (or a 400).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getUsageStats = mock(async () => ({ totalRequests: 0 }));
const getUsageTimeSeries = mock(async () => []);
const getCostTrending = mock(async () => ({}));
const getProviderBreakdown = mock(async () => []);
const getModelBreakdown = mock(async () => []);
const getTrendData = mock(async () => ({}));
const getById = mock(async () => ({ credit_balance: "0" }));

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
  analyticsService: {
    getUsageStats,
    getUsageTimeSeries,
    getCostTrending,
    getProviderBreakdown,
    getModelBreakdown,
    getTrendData,
  },
}));
mock.module("@/lib/services/analytics-derived", () => ({
  deriveCostTrendingFields: () => ({}),
  toSuccessRatePercent: (value: number) => value,
}));
mock.module("@/lib/services/organizations", () => ({
  organizationsService: { getById },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined },
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/analytics/breakdown", route);

function getBreakdown(query = "") {
  return app.request(`/api/analytics/breakdown${query}`);
}

describe("GET /api/analytics/breakdown window identity", () => {
  beforeEach(() => {
    getUsageStats.mockClear();
    getUsageTimeSeries.mockClear();
    getCostTrending.mockClear();
    getProviderBreakdown.mockClear();
    getModelBreakdown.mockClear();
    getTrendData.mockClear();
    getById.mockClear();
  });

  test.each(["", "?timeRange="])(
    "accepts %s as the weekly analytics-breakdown window",
    async (query) => {
      const response = await getBreakdown(query);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        success: boolean;
        data: { filters: { timeRange: string; granularity: string } };
      };
      expect(body.success).toBe(true);
      expect(body.data.filters.timeRange).toBe("weekly");
      expect(body.data.filters.granularity).toBe("day");
      expect(getUsageStats).toHaveBeenCalledTimes(1);
      expect(getById).toHaveBeenCalledTimes(1);
    },
  );

  test("accepts timeRange=monthly as the monthly analytics-breakdown window", async () => {
    const response = await getBreakdown("?timeRange=monthly");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { filters: { timeRange: string } };
    };
    expect(body.data.filters.timeRange).toBe("monthly");
    expect(getUsageStats).toHaveBeenCalledTimes(1);
  });

  test("accepts timeRange=daily as the daily analytics-breakdown window", async () => {
    const response = await getBreakdown("?timeRange=daily");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { filters: { timeRange: string; granularity: string } };
    };
    expect(body.data.filters.timeRange).toBe("daily");
    expect(body.data.filters.granularity).toBe("hour");
    expect(getUsageStats).toHaveBeenCalledTimes(1);
  });

  test.each(["MONTHLY", "DAILY", "week", "foo", "90d"])(
    "rejects timeRange=%s before analytics sinks",
    async (token) => {
      const response = await getBreakdown(`?timeRange=${token}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid timeRange");
      expect(getUsageStats).not.toHaveBeenCalled();
      expect(getUsageTimeSeries).not.toHaveBeenCalled();
      expect(getById).not.toHaveBeenCalled();
    },
  );
});
