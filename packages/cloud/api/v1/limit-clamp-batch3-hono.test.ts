/**
 * Hono route tests for gallery explore and apps analytics limit/offset clamp.
 *
 * Exercises the live gallery and analytics handlers via app.request with mocked
 * services, asserting the strict contract: decimal digits only via /^\d+$/, safe
 * integers, positive limits and non-negative offsets, with documented fallbacks
 * (gallery 20, analytics 50/0) and max 100. Malformed representations such as
 * "5junk", "1e4", "5.5" map to fallback instead of partial parsing.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppsService } from "@/lib/services/apps";
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

const listRandomPublicImageSummaries = mock(async (_limit: number) => []);
mock.module("@/lib/services/generations", () => ({
  generationsService: { listRandomPublicImageSummaries },
}));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const APP_ID = "99999999-9999-4999-8999-000000000001";
const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];
const getById = mock(async (id: string) =>
  id === APP_ID ? { id: APP_ID, organization_id: ORG_A } : null,
);
type RecentRequestOptions = NonNullable<
  Parameters<AppsService["getRecentRequests"]>[1]
>;
const getRecentRequests = mock(
  async (_appId: string, _options: RecentRequestOptions) => ({
    requests: [],
    total: 0,
  }),
);
const getTopVisitors = mock(async () => []);
const getRequestsOverTime = mock(async () => []);
const getRequestStats = mock(async () => ({}));
const getSessionAnalytics = mock(async () => ({
  summary: {
    totalSessions: 0,
    uniqueVisitors: 0,
    totalPageViews: 0,
    avgPagesPerSession: 0,
    avgSessionDurationMs: 0,
    bounceRatePercent: 0,
  },
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
mock.module("@/lib/api/hono-next-style-params", () => ({
  nextStyleParams: () => ({ params: Promise.resolve({ id: APP_ID }) }),
}));

const { default: galleryApp } = await import("./gallery/explore/route");
const { default: analyticsRoute } = await import(
  "./apps/[id]/analytics/requests/route"
);
function buildAnalyticsApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/apps/:id/analytics/requests", analyticsRoute);
  return app;
}
beforeEach(() => {
  listRandomPublicImageSummaries.mockClear();
  getById.mockClear();
  getRecentRequests.mockClear();
  getTopVisitors.mockClear();
  getRequestsOverTime.mockClear();
  getRequestStats.mockClear();
  getSessionAnalytics.mockClear();
});

describe("gallery explore — strict limit clamp (fallback 20, max 100)", () => {
  test("valid 20 → 20", async () => {
    const res = await galleryApp.request("/?limit=20");
    expect(res.status).toBe(200);
    expect(listRandomPublicImageSummaries.mock.calls[0][0]).toBe(20);
  });
  test("valid 50 → 50", async () => {
    const res = await galleryApp.request("/?limit=50");
    expect(res.status).toBe(200);
    expect(listRandomPublicImageSummaries.mock.calls[0][0]).toBe(50);
  });
  test("999 → 100 (clamped)", async () => {
    const res = await galleryApp.request("/?limit=999");
    expect(res.status).toBe(200);
    expect(listRandomPublicImageSummaries.mock.calls[0][0]).toBe(100);
  });
  test("missing → 20", async () => {
    const res = await galleryApp.request("/");
    expect(res.status).toBe(200);
    expect(listRandomPublicImageSummaries.mock.calls[0][0]).toBe(20);
  });
  test("blank → 20", async () => {
    const res = await galleryApp.request("/?limit=");
    expect(res.status).toBe(200);
    expect(listRandomPublicImageSummaries.mock.calls[0][0]).toBe(20);
  });
  test('"5junk" → 20 (strict rejects trailing junk)', async () => {
    const res = await galleryApp.request("/?limit=5junk");
    expect(res.status).toBe(200);
    expect(listRandomPublicImageSummaries.mock.calls[0][0]).toBe(20);
  });
  test('"1e4" → 20 (strict rejects exponent)', async () => {
    const res = await galleryApp.request("/?limit=1e4");
    expect(res.status).toBe(200);
    expect(listRandomPublicImageSummaries.mock.calls[0][0]).toBe(20);
  });
  test('"0" → 20 (strict rejects non-positive)', async () => {
    const res = await galleryApp.request("/?limit=0");
    expect(res.status).toBe(200);
    expect(listRandomPublicImageSummaries.mock.calls[0][0]).toBe(20);
  });
  test('"-5" → 20 (strict rejects negative)', async () => {
    const res = await galleryApp.request("/?limit=-5");
    expect(res.status).toBe(200);
    expect(listRandomPublicImageSummaries.mock.calls[0][0]).toBe(20);
  });
  test('"5.5" → 20 (strict rejects decimal)', async () => {
    const res = await galleryApp.request("/?limit=5.5");
    expect(res.status).toBe(200);
    expect(listRandomPublicImageSummaries.mock.calls[0][0]).toBe(20);
  });
  test("unsafe integer → 20 (isSafeInteger)", async () => {
    const res = await galleryApp.request("/?limit=9007199254740992");
    expect(res.status).toBe(200);
    expect(listRandomPublicImageSummaries.mock.calls[0][0]).toBe(20);
  });
  test("100 → 100 (max boundary)", async () => {
    const res = await galleryApp.request("/?limit=100");
    expect(res.status).toBe(200);
    expect(listRandomPublicImageSummaries.mock.calls[0][0]).toBe(100);
  });
});

describe("apps analytics requests — strict limit (50, max 100) + offset (0)", () => {
  test("valid 50 offset 10 → 50,10", async () => {
    const res = await buildAnalyticsApp().request(
      `/api/v1/apps/${APP_ID}/analytics/requests?view=logs&limit=50&offset=10`,
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    expect(getRecentRequests.mock.calls[0][1].limit).toBe(50);
    expect(getRecentRequests.mock.calls[0][1].offset).toBe(10);
  });
  test("missing → 50,0", async () => {
    const res = await buildAnalyticsApp().request(
      `/api/v1/apps/${APP_ID}/analytics/requests?view=logs`,
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    expect(getRecentRequests.mock.calls[0][1].limit).toBe(50);
    expect(getRecentRequests.mock.calls[0][1].offset).toBe(0);
  });
  test('"5junk" limit → 50', async () => {
    const res = await buildAnalyticsApp().request(
      `/api/v1/apps/${APP_ID}/analytics/requests?view=logs&limit=5junk`,
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    expect(getRecentRequests.mock.calls[0][1].limit).toBe(50);
  });
  test('"1e4" limit → 50', async () => {
    const res = await buildAnalyticsApp().request(
      `/api/v1/apps/${APP_ID}/analytics/requests?view=logs&limit=1e4`,
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    expect(getRecentRequests.mock.calls[0][1].limit).toBe(50);
  });
  test('"5.5" limit → 50', async () => {
    const res = await buildAnalyticsApp().request(
      `/api/v1/apps/${APP_ID}/analytics/requests?view=logs&limit=5.5`,
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    expect(getRecentRequests.mock.calls[0][1].limit).toBe(50);
  });
  test('"0" limit → 50', async () => {
    const res = await buildAnalyticsApp().request(
      `/api/v1/apps/${APP_ID}/analytics/requests?view=logs&limit=0`,
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    expect(getRecentRequests.mock.calls[0][1].limit).toBe(50);
  });
  test("999 → 100 (clamped)", async () => {
    const res = await buildAnalyticsApp().request(
      `/api/v1/apps/${APP_ID}/analytics/requests?view=logs&limit=999`,
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    expect(getRecentRequests.mock.calls[0][1].limit).toBe(100);
  });
  test('"5junk" offset → 0', async () => {
    const res = await buildAnalyticsApp().request(
      `/api/v1/apps/${APP_ID}/analytics/requests?view=logs&offset=5junk`,
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    expect(getRecentRequests.mock.calls[0][1].offset).toBe(0);
  });
  test('"1e4" offset → 0', async () => {
    const res = await buildAnalyticsApp().request(
      `/api/v1/apps/${APP_ID}/analytics/requests?view=logs&offset=1e4`,
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    expect(getRecentRequests.mock.calls[0][1].offset).toBe(0);
  });
  test("valid offset 20 → 20", async () => {
    const res = await buildAnalyticsApp().request(
      `/api/v1/apps/${APP_ID}/analytics/requests?view=logs&limit=50&offset=20`,
      {},
      ENV,
    );
    expect(res.status).toBe(200);
    expect(getRecentRequests.mock.calls[0][1].offset).toBe(20);
  });
});
