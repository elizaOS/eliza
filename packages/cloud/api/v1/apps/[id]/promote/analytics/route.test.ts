/**
 * Exercises the real promote-analytics Hono route with mocked auth and
 * service boundaries. It pins a canonical 1–90 days query before campaign
 * and attribution lookups.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const DAY_MS = 24 * 60 * 60 * 1000;

const getById = mock(async () => ({
  id: "app-1",
  organization_id: "org-1",
}));
const listCampaigns = mock(async () => [
  {
    id: "camp-1",
    name: "Launch",
    platform: "twitter",
    status: "active",
    total_spend: "10.00",
    total_impressions: 1000,
    total_clicks: 50,
    total_conversions: 5,
  },
]);
const getCampaignAttribution = mock(async () => [
  {
    campaignId: "camp-1",
    campaignName: "Launch",
    platform: "twitter",
    signups: 5,
    conversions: 5,
    cost: 10,
  },
]);

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { organization_id: "org-1" },
    apiKey: null,
  }),
}));
mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope: async () => false,
}));
mock.module("@/lib/services/apps", () => ({
  appsService: { getById },
}));
mock.module("@/lib/services/advertising", () => ({
  advertisingService: { listCampaigns },
}));
mock.module("@/lib/services/conversion-tracking", () => ({
  conversionTrackingService: { getCampaignAttribution },
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/v1/apps/:id/promote/analytics", route);

function getAnalytics(query = "") {
  return app.request(`/api/v1/apps/app-1/promote/analytics${query}`);
}

function expectWindowDays(
  body: { dateRange: { start: string; end: string } },
  days: number,
  beforeMs: number,
  afterMs: number,
) {
  const start = Date.parse(body.dateRange.start);
  const end = Date.parse(body.dateRange.end);
  expect(Number.isNaN(start)).toBe(false);
  expect(Number.isNaN(end)).toBe(false);
  expect(end).toBeGreaterThanOrEqual(beforeMs);
  expect(end).toBeLessThanOrEqual(afterMs);
  expect(start).toBeGreaterThanOrEqual(beforeMs - days * DAY_MS);
  expect(start).toBeLessThanOrEqual(afterMs - days * DAY_MS);
}

describe("GET /api/v1/apps/:id/promote/analytics days validation", () => {
  beforeEach(() => {
    getById.mockClear();
    listCampaigns.mockClear();
    getCampaignAttribution.mockClear();
  });

  test("defaults to a 30-day window when days is omitted", async () => {
    const beforeMs = Date.now();
    const response = await getAnalytics();
    const afterMs = Date.now();

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      dateRange: { start: string; end: string };
    };
    expectWindowDays(body, 30, beforeMs, afterMs);
    expect(listCampaigns).toHaveBeenCalledWith("org-1", { appId: "app-1" });
    expect(getCampaignAttribution).toHaveBeenCalledWith("org-1", {
      appId: "app-1",
    });
  });

  test.each([7, 90])(
    "accepts a valid base-10 days value of %i",
    async (days) => {
      const beforeMs = Date.now();
      const response = await getAnalytics(`?days=${days}`);
      const afterMs = Date.now();

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        dateRange: { start: string; end: string };
      };
      expectWindowDays(body, days, beforeMs, afterMs);
      expect(listCampaigns).toHaveBeenCalledTimes(1);
      expect(getCampaignAttribution).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    ["malformed", "abc"],
    ["zero", "0"],
    ["negative", "-5"],
    ["fractional", "1.5"],
    ["scientific", "1e9"],
    ["prefix-tolerant", "30abc"],
    ["hex", "0x1e"],
    ["leading-zero", "07"],
    ["explicit-plus", "+7"],
    ["surrounding-whitespace", " 7 "],
    ["empty", ""],
    ["above maximum", "999999"],
  ])(
    "rejects %s days=%s before campaign and attribution lookups",
    async (_name, days) => {
      const response = await getAnalytics(`?days=${encodeURIComponent(days)}`);

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body).toEqual({ error: "Invalid days" });
      expect(listCampaigns).not.toHaveBeenCalled();
      expect(getCampaignAttribution).not.toHaveBeenCalled();
    },
  );
});
