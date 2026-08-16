/**
 * Exercises the mounted analytics export Hono route with mocked auth, rate
 * limiting, export formatting, and analytics services. Invalid date queries
 * must fail before service lookups instead of reaching filename serialization.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

type AnalyticsRange = {
  startDate: Date;
  endDate: Date;
  granularity?: string;
  limit?: number;
};

const getUsageByUser = mock(
  async (_organizationId: string, _range: AnalyticsRange) => [],
);
const getModelBreakdown = mock(
  async (_organizationId: string, _range: AnalyticsRange) => [],
);
const getProviderBreakdown = mock(
  async (_organizationId: string, _range: AnalyticsRange) => [],
);
const getUsageTimeSeries = mock(
  async (_organizationId: string, _range: AnalyticsRange) => [],
);

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
  getModelBreakdown,
  getProviderBreakdown,
  getUsageByUser,
  getUsageTimeSeries,
  validateGranularity: (value: string) =>
    ["hour", "day", "week", "month"].includes(value),
}));
mock.module("@/lib/export/analytics", () => ({
  createBinaryDownloadResponse: () => new Response(""),
  createDownloadResponse: (body: string) => new Response(body),
  formatCurrency: String,
  formatDate: String,
  formatNumber: String,
  formatPercentage: String,
  generateCSV: () => "timestamp,requests\n",
  generateExcel: async () => new Uint8Array(),
  generateJSON: () => "[]",
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined },
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/analytics/export", route);

function getExport(query = "") {
  return app.request(`/api/analytics/export${query}`);
}

function clearServiceMocks() {
  getUsageByUser.mockClear();
  getModelBreakdown.mockClear();
  getProviderBreakdown.mockClear();
  getUsageTimeSeries.mockClear();
}

function expectNoServiceLookups() {
  expect(getUsageByUser).not.toHaveBeenCalled();
  expect(getModelBreakdown).not.toHaveBeenCalled();
  expect(getProviderBreakdown).not.toHaveBeenCalled();
  expect(getUsageTimeSeries).not.toHaveBeenCalled();
}

describe("GET /api/analytics/export date validation", () => {
  beforeEach(clearServiceMocks);

  test("keeps the default 30-day export when dates are omitted", async () => {
    const response = await getExport();

    expect(response.status).toBe(200);
    expect(getUsageTimeSeries).toHaveBeenCalledTimes(1);
    const [, range] = getUsageTimeSeries.mock.calls[0];
    expect(range.endDate.getTime() - range.startDate.getTime()).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
  });

  test("accepts valid ISO and date-only query values", async () => {
    const response = await getExport(
      "?startDate=2026-07-01&endDate=2026-07-31T00%3A00%3A00.000Z",
    );

    expect(response.status).toBe(200);
    expect(getUsageTimeSeries).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["startDate", "abc"],
    ["startDate", "not-a-date"],
    ["startDate", "2026-13-40"],
    ["startDate", " "],
    ["endDate", "abc"],
    ["endDate", "2026-13-40"],
  ])("rejects invalid %s=%s before analytics lookups", async (field, value) => {
    const response = await getExport(`?${field}=${encodeURIComponent(value)}`);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body).toEqual({ error: `Invalid ${field}` });
    expectNoServiceLookups();
  });
});
