/**
 * GET /api/v1/apps/:id/analytics/requests `view` is request-analytics
 * view identity, not leftover Life Ops views viewType or analytics
 * periods tax. Stock develop defaulted unknown tokens to stats, so
 * `view=LOGS` / `STATS` / `foo` returned the stats dashboard.
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
  RateLimitPresets: { AGGRESSIVE: {}, STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const APP_ID = "99999999-9999-4999-8999-000000000001";
const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

const getById = mock(async (id: string) =>
  id === APP_ID ? { id: APP_ID, organization_id: ORG_A } : null,
);
const getRecentRequests = mock(async () => ({ requests: [], total: 0 }));
const getTopVisitors = mock(async () => []);
const getRequestsOverTime = mock(async () => []);
const getRequestStats = mock(async () => ({ hits: 1 }));
const getSessionAnalytics = mock(async () => ({
  summary: { totalSessions: 0 },
  sessions: [],
  funnel: { totalEntrants: 0, steps: [] },
}));

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { organization_id: ORG_A },
    apiKey: null,
  }),
}));
mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope: async () => false,
}));
mock.module("@/lib/services/apps", () => ({
  appsService: {
    getById,
    getRecentRequests,
    getTopVisitors,
    getRequestsOverTime,
    getRequestStats,
  },
}));
mock.module("@/lib/services/app-analytics", () => ({
  appAnalyticsService: { getSessionAnalytics },
}));
mock.module("@/lib/api/date-range-params", () => ({
  parseDateRangeParams: () => ({
    success: true,
    startDate: undefined,
    endDate: undefined,
  }),
}));

const { default: analyticsRoute } = await import("./route");

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/apps/:id/analytics/requests", analyticsRoute);
  return app;
}

function request(query = "") {
  return buildApp().request(
    `/api/v1/apps/${APP_ID}/analytics/requests${query}`,
    {},
    ENV,
  );
}

describe("GET /api/v1/apps/:id/analytics/requests view identity", () => {
  beforeEach(() => {
    getById.mockClear();
    getRecentRequests.mockClear();
    getTopVisitors.mockClear();
    getRequestsOverTime.mockClear();
    getRequestStats.mockClear();
    getSessionAnalytics.mockClear();
  });

  test.each(["", "?view="])("accepts %s as stats", async (query) => {
    const response = await request(query);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; stats: unknown };
    expect(body.success).toBe(true);
    expect(body.stats).toEqual({ hits: 1 });
    expect(getRequestStats).toHaveBeenCalledTimes(1);
    expect(getRecentRequests).not.toHaveBeenCalled();
    expect(getTopVisitors).not.toHaveBeenCalled();
    expect(getRequestsOverTime).not.toHaveBeenCalled();
    expect(getSessionAnalytics).not.toHaveBeenCalled();
  });

  test("accepts view=logs as the request log", async () => {
    const response = await request("?view=logs");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; requests: unknown };
    expect(body.success).toBe(true);
    expect(body.requests).toEqual([]);
    expect(getRecentRequests).toHaveBeenCalledTimes(1);
    expect(getRequestStats).not.toHaveBeenCalled();
  });

  test("accepts view=stats as the stats dashboard", async () => {
    const response = await request("?view=stats");
    expect(response.status).toBe(200);
    expect(getRequestStats).toHaveBeenCalledTimes(1);
    expect(getRecentRequests).not.toHaveBeenCalled();
  });

  test("accepts view=visitors as top visitors", async () => {
    const response = await request("?view=visitors");
    expect(response.status).toBe(200);
    expect(getTopVisitors).toHaveBeenCalledTimes(1);
    expect(getRequestStats).not.toHaveBeenCalled();
  });

  test("accepts view=timeline as the request timeline", async () => {
    const response = await request("?view=timeline");
    expect(response.status).toBe(200);
    expect(getRequestsOverTime).toHaveBeenCalledTimes(1);
    expect(getRequestStats).not.toHaveBeenCalled();
  });

  test("accepts view=sessions as session analytics", async () => {
    const response = await request("?view=sessions");
    expect(response.status).toBe(200);
    expect(getSessionAnalytics).toHaveBeenCalledTimes(1);
    expect(getRequestStats).not.toHaveBeenCalled();
  });

  test.each(["LOGS", "STATS", "Timeline", "foo", "1e2"])(
    "rejects view=%s before any view sink",
    async (token) => {
      const response = await request(`?view=${token}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_view");
      expect(getById).not.toHaveBeenCalled();
      expect(getRecentRequests).not.toHaveBeenCalled();
      expect(getTopVisitors).not.toHaveBeenCalled();
      expect(getRequestsOverTime).not.toHaveBeenCalled();
      expect(getRequestStats).not.toHaveBeenCalled();
      expect(getSessionAnalytics).not.toHaveBeenCalled();
    },
  );
});
