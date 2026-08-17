/**
 * Exercises the real app-earnings Hono route with mocked auth and service boundaries.
 * It pins strict days validation before any app or earnings lookup.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getById = mock(async () => ({
  id: "app-1",
  organization_id: "org-1",
  monetization_enabled: true,
  inference_markup_percentage: "10",
  purchase_share_percentage: "5",
  platform_offset_amount: "0",
  total_creator_earnings: "100",
  total_platform_revenue: "20",
}));
const getEarningsSummary = mock(async () => ({ total: 100 }));
const getEarningsBreakdown = mock(async () => ({ thisMonth: { total: 20 } }));
const getTransactionHistory = mock(async () => []);
const getDailyEarningsChart = mock(async (_appId: string, days: number) => {
  if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
    throw new RangeError("Invalid time value");
  }
  return [];
});

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
mock.module("@/lib/services/app-earnings", () => ({
  appEarningsService: {
    getEarningsSummary,
    getEarningsBreakdown,
    getTransactionHistory,
    getDailyEarningsChart,
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock() },
}));

const route = (await import("../v1/apps/[id]/earnings/route")).default;
const app = new Hono().route("/api/v1/apps/:id/earnings", route);

function getEarnings(query = "") {
  return app.request(`/api/v1/apps/app-1/earnings${query}`);
}

const earningsMocks = [
  getEarningsSummary,
  getEarningsBreakdown,
  getTransactionHistory,
  getDailyEarningsChart,
];

describe("GET /api/v1/apps/:id/earnings days validation", () => {
  beforeEach(() => {
    getById.mockClear();
    for (const serviceMock of earningsMocks) serviceMock.mockClear();
  });

  test.each([
    ["", 30],
    ["?days=", 30],
    ["?days=1", 1],
    ["?days=7", 7],
    ["?days=30", 30],
    ["?days=90", 90],
  ])("accepts %s and forwards %i days", async (query, expectedDays) => {
    const response = await getEarnings(query);

    expect(response.status).toBe(200);
    expect(getById).toHaveBeenCalledTimes(1);
    expect(getDailyEarningsChart).toHaveBeenCalledWith("app-1", expectedDays);
  });

  test.each([
    ["malformed", "abc"],
    ["not-a-number", "NaN"],
    ["infinite", "Infinity"],
    ["whitespace", "   "],
    ["zero", "0"],
    ["negative", "-1"],
    ["partial", "30abc"],
    ["fractional", "1.5"],
    ["exponent form", "2e3"],
    ["leading zero", "07"],
    ["explicit plus", "+7"],
    ["surrounding whitespace", " 7 "],
    ["above maximum", "91"],
    ["unsafe integer", "9007199254740992"],
  ])("rejects %s days before app lookup", async (_name, days) => {
    const response = await getEarnings(`?days=${encodeURIComponent(days)}`);

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      success: boolean;
      error: string;
    };
    expect(body).toEqual({ success: false, error: "Invalid days" });
    expect(getById).not.toHaveBeenCalled();
    for (const serviceMock of earningsMocks) {
      expect(serviceMock).not.toHaveBeenCalled();
    }
  });
});
