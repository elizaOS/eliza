/**
 * Exercises app-analytics period validation through the HTTP route with mocked
 * authentication and service boundaries.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(() => undefined) },
}));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const APP_ID = "99999999-9999-4999-8999-000000000001";
const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

const getById = mock(async (id: string) =>
  id === APP_ID ? { id: APP_ID, organization_id: ORG_A } : null,
);
const getAnalytics = mock(
  async (
    _appId: string,
    _periodType: "hourly" | "daily" | "monthly",
    _startDate: Date,
    _endDate: Date,
  ) => [],
);
const getTotalStats = mock(async () => ({
  totalRequests: 0,
  totalUsers: 0,
  totalCreditsUsed: "0.00",
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: ORG_A,
  }),
}));
mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope: async () => false,
}));
mock.module("@/lib/services/apps", () => ({
  appsService: { getById, getAnalytics, getTotalStats },
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
  app.route("/api/v1/apps/:id/analytics", analyticsRoute);
  return app;
}

function request(query = "") {
  return buildApp().request(
    `/api/v1/apps/${APP_ID}/analytics${query}`,
    {},
    ENV,
  );
}

describe("GET /api/v1/apps/:id/analytics grain identity", () => {
  beforeEach(() => {
    getById.mockClear();
    getAnalytics.mockClear();
    getTotalStats.mockClear();
  });

  test.each(["", "?period="])(
    "accepts %s as the daily app-analytics grain",
    async (query) => {
      const response = await request(query);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        success: boolean;
        period: { type: string };
      };
      expect(body.success).toBe(true);
      expect(body.period.type).toBe("daily");
      expect(getAnalytics).toHaveBeenCalledTimes(1);
      expect(getAnalytics.mock.calls[0][1]).toBe("daily");
    },
  );

  test("accepts period=monthly as the monthly app-analytics grain", async () => {
    const response = await request("?period=monthly");
    expect(response.status).toBe(200);
    expect(getAnalytics).toHaveBeenCalledTimes(1);
    expect(getAnalytics.mock.calls[0][1]).toBe("monthly");
  });

  test.each(["MONTHLY", "HOURLY", "week", "foo"])(
    "rejects period=%s before getAnalytics",
    async (token) => {
      const response = await request(`?period=${token}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_period");
      expect(getAnalytics).not.toHaveBeenCalled();
      expect(getById).not.toHaveBeenCalled();
    },
  );
});
