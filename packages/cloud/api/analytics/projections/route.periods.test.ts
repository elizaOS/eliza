/**
 * GET /api/analytics/projections `periods` is the forecast horizon (1..90),
 * not a leftover enum catalog and not a page-size limit. Stock develop used
 * Number(periods) and fail-opened prefix/scientific garbage to 7 or a capped
 * 90-day forecast. The UI contract is canonical 1..90 only.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getUsageTimeSeries = mock(
  async (_organizationId: string, _range: unknown) => [
    {
      timestamp: new Date("2026-08-01T00:00:00.000Z"),
      totalRequests: 1,
      totalCost: 1,
      inputTokens: 1,
      outputTokens: 1,
      successRate: 1,
    },
    {
      timestamp: new Date("2026-08-02T00:00:00.000Z"),
      totalRequests: 2,
      totalCost: 2,
      inputTokens: 2,
      outputTokens: 2,
      successRate: 1,
    },
    {
      timestamp: new Date("2026-08-03T00:00:00.000Z"),
      totalRequests: 3,
      totalCost: 3,
      inputTokens: 3,
      outputTokens: 3,
      successRate: 1,
    },
  ],
);
const generateProjections = mock((_historical: unknown, periods: number) => [
  { periods },
]);
const generateProjectionAlerts = mock(() => []);
const persistProjectionAlerts = mock(async () => []);
const getById = mock(async () => ({ credit_balance: 0 }));

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
  analyticsService: { getUsageTimeSeries },
}));
mock.module("@/lib/services/analytics-alerts", () => ({
  analyticsAlertsService: { persistProjectionAlerts },
}));
mock.module("@/lib/services/analytics-derived", () => ({
  toSuccessRatePercent: (value: number) => value,
}));
mock.module("@/lib/services/organizations", () => ({
  organizationsService: { getById },
}));
mock.module("@/lib/analytics/projections", () => ({
  generateProjections,
  generateProjectionAlerts,
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined },
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/analytics/projections", route);

function getProjections(query = "") {
  return app.request(`/api/analytics/projections${query}`);
}

function clearMocks() {
  getUsageTimeSeries.mockClear();
  generateProjections.mockClear();
  generateProjectionAlerts.mockClear();
  persistProjectionAlerts.mockClear();
  getById.mockClear();
}

function expectNoForecast() {
  expect(getUsageTimeSeries).not.toHaveBeenCalled();
  expect(generateProjections).not.toHaveBeenCalled();
  expect(persistProjectionAlerts).not.toHaveBeenCalled();
}

describe("GET /api/analytics/projections periods horizon", () => {
  beforeEach(clearMocks);

  test("omitted periods still forecasts the default 7-day horizon", async () => {
    const response = await getProjections();
    expect(response.status).toBe(200);
    expect(generateProjections).toHaveBeenCalledTimes(1);
    expect(generateProjections.mock.calls[0][1]).toBe(7);
  });

  test.each([
    ["7", 7],
    ["1", 1],
    ["90", 90],
    ["91", 90],
  ])("periods=%s forecasts %s periods", async (token, horizon) => {
    const response = await getProjections(`?periods=${token}`);
    expect(response.status).toBe(200);
    expect(generateProjections.mock.calls[0][1]).toBe(horizon);
  });

  test.each(["1e2", "12px", "007", "7.5", "0", "-1", "foo", "Infinity"])(
    "rejects periods=%s before usage lookup",
    async (token) => {
      const response = await getProjections(
        `?periods=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/periods/i);
      expectNoForecast();
    },
  );
});
