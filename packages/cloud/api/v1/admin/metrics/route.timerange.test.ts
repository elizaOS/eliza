/**
 * GET /api/v1/admin/metrics `timeRange` is admin-engagement window
 * identity, not leftover app-analytics periods tax. Stock develop
 * mapped unknown tokens to 30d, so `timeRange=90D` / `foo` returned
 * a month of engagement instead of 90 days (or a 400).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_c: unknown, err: unknown) => {
    throw err;
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(() => undefined) },
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const requireAdmin = mock(async () => ({
  id: "admin-1",
  organization_id: "org-1",
  role: "super_admin",
}));
const getMetricsOverview = mock(async (days: number) => ({ view: "overview", days }));
const getDailyMetrics = mock(async () => ({ view: "daily" }));
const getRetentionCohorts = mock(async () => ({ view: "retention" }));
const getActiveUsers = mock(async (range: string) => ({ view: "active", range }));
const getNewSignups = mock(async () => ({ view: "signups" }));
const getOAuthConnectionRate = mock(async () => ({ view: "oauth" }));

mock.module("@/lib/auth/workers-hono-auth", () => ({ requireAdmin }));
mock.module("@/lib/services/user-metrics", () => ({
  userMetricsService: {
    getMetricsOverview,
    getDailyMetrics,
    getRetentionCohorts,
    getActiveUsers,
    getNewSignups,
    getOAuthConnectionRate,
  },
}));

const { default: metricsRoute } = await import("./route");

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/admin/metrics", metricsRoute);
  return app;
}

function request(query = "") {
  return buildApp().request(`/api/v1/admin/metrics${query}`);
}

describe("GET /api/v1/admin/metrics timeRange identity", () => {
  beforeEach(() => {
    requireAdmin.mockClear();
    getMetricsOverview.mockClear();
    getDailyMetrics.mockClear();
    getRetentionCohorts.mockClear();
    getActiveUsers.mockClear();
    getNewSignups.mockClear();
    getOAuthConnectionRate.mockClear();
  });

  test.each(["", "?timeRange="])("accepts %s as the 30-day overview", async (query) => {
    const response = await request(query);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { view: string; days: number };
    expect(body).toEqual({ view: "overview", days: 30 });
    expect(getMetricsOverview).toHaveBeenCalledTimes(1);
    expect(getMetricsOverview.mock.calls[0][0]).toBe(30);
    expect(getDailyMetrics).not.toHaveBeenCalled();
    expect(getRetentionCohorts).not.toHaveBeenCalled();
    expect(getActiveUsers).not.toHaveBeenCalled();
  });

  test.each([
    ["7d", 7],
    ["30d", 30],
    ["90d", 90],
  ] as const)("accepts timeRange=%s as a %s-day overview", async (token, days) => {
    const response = await request(`?timeRange=${token}`);
    expect(response.status).toBe(200);
    expect(getMetricsOverview).toHaveBeenCalledTimes(1);
    expect(getMetricsOverview.mock.calls[0][0]).toBe(days);
  });

  test("accepts view=daily&timeRange=7d as the 7-day daily series", async () => {
    const response = await request("?view=daily&timeRange=7d");
    expect(response.status).toBe(200);
    expect(getDailyMetrics).toHaveBeenCalledTimes(1);
    expect(getMetricsOverview).not.toHaveBeenCalled();
  });

  test.each(["90D", "7D", "foo", "1e2"])(
    "rejects timeRange=%s before any metrics sink",
    async (token) => {
      const response = await request(`?timeRange=${token}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_time_range");
      expect(getMetricsOverview).not.toHaveBeenCalled();
      expect(getDailyMetrics).not.toHaveBeenCalled();
      expect(getRetentionCohorts).not.toHaveBeenCalled();
      expect(getActiveUsers).not.toHaveBeenCalled();
      expect(getNewSignups).not.toHaveBeenCalled();
      expect(getOAuthConnectionRate).not.toHaveBeenCalled();
    },
  );
});
