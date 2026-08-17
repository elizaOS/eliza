/**
 * GET /api/analytics/export `includeMetadata` is export-metadata
 * identity, not leftover tax on export `type` (#20933), granularity,
 * format, or date parsers. Stock develop treated any non-exact `true`
 * token as omit-metadata, so `includeMetadata=TRUE` still downloaded
 * a bare series instead of a 400.
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
const generateCSV = mock(
  (
    _data: unknown,
    _columns: unknown,
    _options?: { includeMetadata?: boolean },
  ) => "timestamp,requests\n",
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
  generateCSV,
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
  generateCSV.mockClear();
}

function expectNoServiceLookups() {
  expect(getUsageByUser).not.toHaveBeenCalled();
  expect(getModelBreakdown).not.toHaveBeenCalled();
  expect(getProviderBreakdown).not.toHaveBeenCalled();
  expect(getUsageTimeSeries).not.toHaveBeenCalled();
  expect(generateCSV).not.toHaveBeenCalled();
}

describe("GET /api/analytics/export includeMetadata identity", () => {
  beforeEach(clearServiceMocks);

  test.each(["", "?includeMetadata=", "?includeMetadata=false"])(
    "accepts %s as omit-metadata timeseries export",
    async (query) => {
      const response = await getExport(query);
      expect(response.status).toBe(200);
      expect(getUsageTimeSeries).toHaveBeenCalledTimes(1);
      expect(generateCSV).toHaveBeenCalledTimes(1);
      expect(generateCSV.mock.calls[0][2]).toMatchObject({
        includeMetadata: false,
      });
    },
  );

  test("accepts includeMetadata=true as metadata-bearing export", async () => {
    const response = await getExport("?includeMetadata=true");
    expect(response.status).toBe(200);
    expect(getUsageTimeSeries).toHaveBeenCalledTimes(1);
    expect(generateCSV).toHaveBeenCalledTimes(1);
    expect(generateCSV.mock.calls[0][2]).toMatchObject({
      includeMetadata: true,
    });
  });

  test.each(["FALSE", "TRUE", "0", "1", "no", "yes", "foo"])(
    "rejects includeMetadata=%s before analytics lookups",
    async (token) => {
      const response = await getExport(
        `?includeMetadata=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid includeMetadata");
      expectNoServiceLookups();
    },
  );
});
