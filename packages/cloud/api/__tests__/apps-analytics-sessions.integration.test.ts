/**
 * App analytics requests route — real Hono route, mocked auth/data seams.
 * Pins the hosted-frontend sessions view added for #11349 without requiring a
 * live Worker or database.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as realAuth from "@/lib/auth";
import * as realAppKeyScope from "@/lib/auth/app-key-scope";
import * as realAnalytics from "@/lib/services/app-analytics";
import * as realApps from "@/lib/services/apps";
import type { AppEnv } from "@/types/cloud-worker-env";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const APP_ID = "99999999-9999-4999-8999-000000000001";
const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

let authOrg = ORG_A;
const getById = mock(async (id: string) =>
  id === APP_ID ? { id: APP_ID, organization_id: ORG_A } : null,
);
const getRecentRequests = mock(async () => ({ requests: [], total: 0 }));
const getTopVisitors = mock(async () => []);
const getRequestsOverTime = mock(async () => []);
const getRequestStats = mock(async () => ({ totalRequests: 0 }));
const getSessionAnalytics = mock(async () => ({
  summary: {
    totalSessions: 2,
    uniqueVisitors: 2,
    totalPageViews: 5,
    avgPagesPerSession: 2.5,
    avgSessionDurationMs: 120000,
    bounceRatePercent: 0,
  },
  sessions: [
    {
      sessionId: "session-a",
      visitorId: "visitor-a",
      startedAt: "2026-07-02T12:00:00.000Z",
      endedAt: "2026-07-02T12:04:00.000Z",
      durationMs: 240000,
      pageViews: 3,
      entryPath: "/",
      exitPath: "/checkout",
    },
  ],
  funnel: {
    totalEntrants: 2,
    steps: [
      {
        path: "/",
        label: "Home",
        sessions: 2,
        visitors: 2,
        conversionFromStartPercent: 100,
        conversionFromPreviousPercent: 100,
      },
      {
        path: "/checkout",
        label: "Checkout",
        sessions: 1,
        visitors: 1,
        conversionFromStartPercent: 50,
        conversionFromPreviousPercent: 50,
      },
    ],
  },
}));

mock.module("@/lib/auth", () => ({
  ...realAuth,
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { organization_id: authOrg },
    apiKey: null,
  }),
}));
mock.module("@/lib/services/apps", () => ({
  ...realApps,
  appsService: {
    getById,
    getRecentRequests,
    getTopVisitors,
    getRequestsOverTime,
    getRequestStats,
  },
}));
mock.module("@/lib/services/app-analytics", () => ({
  ...realAnalytics,
  appAnalyticsService: {
    getSessionAnalytics,
  },
}));
mock.module("@/lib/auth/app-key-scope", () => ({
  ...realAppKeyScope,
  isAppKeyOutOfScope: async () => false,
}));

const route = (await import("../v1/apps/[id]/analytics/requests/route"))
  .default;

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/apps/:id/analytics/requests", route);
  return app;
}

describe("app analytics sessions route (#11349)", () => {
  beforeEach(() => {
    authOrg = ORG_A;
    getById.mockClear();
    getRecentRequests.mockClear();
    getTopVisitors.mockClear();
    getRequestsOverTime.mockClear();
    getRequestStats.mockClear();
    getSessionAnalytics.mockClear();
  });

  test("returns computed sessions + funnel DTO for the owning org", async () => {
    const app = buildApp();
    const res = await app.request(
      `/api/v1/apps/${APP_ID}/analytics/requests?view=sessions&limit=40&funnel_steps=/,/checkout`,
      {},
      ENV,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      sessions: {
        summary: { totalSessions: number };
        funnel: { steps: Array<{ path: string }> };
      };
    };
    expect(body.success).toBe(true);
    expect(body.sessions.summary.totalSessions).toBe(2);
    expect(
      body.sessions.funnel.steps.map((step: { path: string }) => step.path),
    ).toEqual(["/", "/checkout"]);
    expect(getSessionAnalytics).toHaveBeenCalledWith(
      APP_ID,
      expect.objectContaining({
        startDate: undefined,
        endDate: undefined,
        limit: 40,
        funnelSteps: ["/", "/checkout"],
      }),
    );
  });

  test("rejects malformed start_date before app or analytics reads", async () => {
    const app = buildApp();
    const res = await app.request(
      `/api/v1/apps/${APP_ID}/analytics/requests?start_date=not-a-date`,
      {},
      ENV,
    );

    expect(res.status).toBe(400);
    expect((await res.json()) as { success: boolean; error: string }).toEqual({
      success: false,
      error: "Invalid start_date",
    });
    expect(getById).not.toHaveBeenCalled();
    expect(getRequestStats).not.toHaveBeenCalled();
    expect(getSessionAnalytics).not.toHaveBeenCalled();
  });

  test("rejects non-ISO start_date before app or analytics reads", async () => {
    const app = buildApp();
    const res = await app.request(
      `/api/v1/apps/${APP_ID}/analytics/requests?start_date=0`,
      {},
      ENV,
    );

    expect(res.status).toBe(400);
    expect((await res.json()) as { success: boolean; error: string }).toEqual({
      success: false,
      error: "Invalid start_date",
    });
    expect(getById).not.toHaveBeenCalled();
    expect(getRequestStats).not.toHaveBeenCalled();
    expect(getSessionAnalytics).not.toHaveBeenCalled();
  });

  test("rejects malformed end_date before app or analytics reads", async () => {
    const app = buildApp();
    const res = await app.request(
      `/api/v1/apps/${APP_ID}/analytics/requests?end_date=not-a-date`,
      {},
      ENV,
    );

    expect(res.status).toBe(400);
    expect((await res.json()) as { success: boolean; error: string }).toEqual({
      success: false,
      error: "Invalid end_date",
    });
    expect(getById).not.toHaveBeenCalled();
    expect(getRequestStats).not.toHaveBeenCalled();
    expect(getSessionAnalytics).not.toHaveBeenCalled();
  });

  test("rejects impossible end_date before app or analytics reads", async () => {
    const app = buildApp();
    const res = await app.request(
      `/api/v1/apps/${APP_ID}/analytics/requests?end_date=2026-02-30T00:00:00.000Z`,
      {},
      ENV,
    );

    expect(res.status).toBe(400);
    expect((await res.json()) as { success: boolean; error: string }).toEqual({
      success: false,
      error: "Invalid end_date",
    });
    expect(getById).not.toHaveBeenCalled();
    expect(getRequestStats).not.toHaveBeenCalled();
    expect(getSessionAnalytics).not.toHaveBeenCalled();
  });

  test("rejects dates outside the database range before reads", async () => {
    const app = buildApp();

    for (const [field, value] of [
      ["start_date", "0000-01-01"],
      ["end_date", "0001-01-01T00:00:00%2B01:00"],
      ["end_date", "9999-12-31T23:59:59-01:00"],
    ]) {
      const res = await app.request(
        `/api/v1/apps/${APP_ID}/analytics/requests?${field}=${value}`,
        {},
        ENV,
      );

      expect(res.status).toBe(400);
      expect((await res.json()) as { success: boolean; error: string }).toEqual(
        {
          success: false,
          error: `Invalid ${field}`,
        },
      );
    }
    expect(getById).not.toHaveBeenCalled();
    expect(getRequestStats).not.toHaveBeenCalled();
    expect(getSessionAnalytics).not.toHaveBeenCalled();
  });

  test("rejects reversed supplied bounds before app or analytics reads", async () => {
    const app = buildApp();
    const res = await app.request(
      `/api/v1/apps/${APP_ID}/analytics/requests?start_date=2026-07-03T00:00:00.000Z&end_date=2026-07-02T00:00:00.000Z`,
      {},
      ENV,
    );

    expect(res.status).toBe(400);
    expect(getById).not.toHaveBeenCalled();
    expect(getRequestStats).not.toHaveBeenCalled();
    expect(getSessionAnalytics).not.toHaveBeenCalled();
  });

  test("passes valid supplied bounds to every analytics view", async () => {
    const app = buildApp();
    const startDate = new Date("2026-07-01T12:30:00.000Z");
    const endDate = new Date("2026-07-02T15:45:00.000Z");
    const cases = [
      {
        view: "stats",
        verify: () =>
          expect(getRequestStats).toHaveBeenCalledWith(
            APP_ID,
            startDate,
            endDate,
          ),
      },
      {
        view: "logs",
        verify: () =>
          expect(getRecentRequests).toHaveBeenCalledWith(
            APP_ID,
            expect.objectContaining({ startDate, endDate }),
          ),
      },
      {
        view: "visitors",
        verify: () =>
          expect(getTopVisitors).toHaveBeenCalledWith(
            APP_ID,
            50,
            startDate,
            endDate,
          ),
      },
      {
        view: "timeline",
        verify: () =>
          expect(getRequestsOverTime).toHaveBeenCalledWith(
            APP_ID,
            "daily",
            startDate,
            endDate,
          ),
      },
      {
        view: "sessions",
        verify: () =>
          expect(getSessionAnalytics).toHaveBeenCalledWith(
            APP_ID,
            expect.objectContaining({ startDate, endDate }),
          ),
      },
    ];

    for (const { view, verify } of cases) {
      const res = await app.request(
        `/api/v1/apps/${APP_ID}/analytics/requests?view=${view}&start_date=${startDate.toISOString()}&end_date=${endDate.toISOString()}`,
        {},
        ENV,
      );

      expect(res.status).toBe(200);
      verify();
    }
  });

  test("accepts a local ISO datetime", async () => {
    const app = buildApp();
    const res = await app.request(
      `/api/v1/apps/${APP_ID}/analytics/requests?start_date=2026-07-01T12:30`,
      {},
      ENV,
    );

    expect(res.status).toBe(200);
    expect(getRequestStats).toHaveBeenCalledWith(
      APP_ID,
      new Date("2026-07-01T12:30"),
      undefined,
    );
  });

  test("accepts date-only and offset bounds", async () => {
    const app = buildApp();
    const res = await app.request(
      `/api/v1/apps/${APP_ID}/analytics/requests?start_date=2026-07-01&end_date=2026-07-02T15:45:00%2B02:00`,
      {},
      ENV,
    );

    expect(res.status).toBe(200);
    expect(getRequestStats).toHaveBeenCalledWith(
      APP_ID,
      new Date("2026-07-01"),
      new Date("2026-07-02T15:45:00+02:00"),
    );
  });

  test("denies another org before reading session analytics", async () => {
    authOrg = ORG_B;
    const app = buildApp();
    const res = await app.request(
      `/api/v1/apps/${APP_ID}/analytics/requests?view=sessions`,
      {},
      ENV,
    );

    expect(res.status).toBe(403);
    expect(getSessionAnalytics).not.toHaveBeenCalled();
  });
});
