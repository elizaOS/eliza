/**
 * GET /api/v1/admin/ai-pricing `billingSource` / `productFamily` are
 * admin pricing-catalog identity, not leftover tax on admin metrics
 * timeRange or analytics export type. Stock develop passed unknown
 * tokens into listPersistedPricingEntries, so `billingSource=GATEWAY`
 * / `productFamily=LANGUAGE` silently returned an empty catalog.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import {
  PRICING_BILLING_SOURCES,
  PRICING_PRODUCT_FAMILIES,
} from "@/lib/services/ai-pricing-definitions";
import type { AppEnv } from "@/types/cloud-worker-env";

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_c: unknown, err: unknown) => {
    throw err;
  },
}));

const requireAdmin = mock(async () => ({
  user: { id: "admin-1" },
  role: "admin",
}));
const listPersistedPricingEntries = mock(async () => []);
const listRecentPricingRefreshRuns = mock(async () => []);

mock.module("@/db/repositories/ai-pricing", () => ({
  aiPricingRepository: {},
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireAdmin,
}));
mock.module("@/lib/services/ai-pricing", () => ({
  buildDimensionKey: mock(() => ""),
  listPersistedPricingEntries,
  listRecentPricingRefreshRuns,
  normalizePricingDimensions: mock((value: unknown) => value),
  refreshPricingCatalog: mock(async () => ({ success: true })),
}));

const { default: pricingRoute } = await import("./route");

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/admin/ai-pricing", pricingRoute);
  return app;
}

function request(query = "") {
  return buildApp().request(`/api/v1/admin/ai-pricing${query}`);
}

describe("GET /api/v1/admin/ai-pricing catalog-filter identity", () => {
  beforeEach(() => {
    requireAdmin.mockClear();
    listPersistedPricingEntries.mockClear();
    listRecentPricingRefreshRuns.mockClear();
  });

  test.each([
    "",
    "?billingSource=",
    "?productFamily=",
    "?billingSource=&productFamily=",
  ])("accepts %s as an unfiltered pricing catalog", async (query) => {
    const response = await request(query);
    expect(response.status).toBe(200);
    expect(listPersistedPricingEntries).toHaveBeenCalledTimes(1);
    expect(listPersistedPricingEntries).toHaveBeenCalledWith({
      billingSource: undefined,
      provider: undefined,
      model: undefined,
      productFamily: undefined,
      chargeType: undefined,
    });
    expect(listRecentPricingRefreshRuns).toHaveBeenCalledTimes(1);
  });

  test("accepts billingSource=gateway as the gateway pricing catalog", async () => {
    const response = await request("?billingSource=gateway");
    expect(response.status).toBe(200);
    expect(listPersistedPricingEntries).toHaveBeenCalledWith({
      billingSource: "gateway",
      provider: undefined,
      model: undefined,
      productFamily: undefined,
      chargeType: undefined,
    });
  });

  test("accepts productFamily=language as the language pricing catalog", async () => {
    const response = await request("?productFamily=language");
    expect(response.status).toBe(200);
    expect(listPersistedPricingEntries).toHaveBeenCalledWith({
      billingSource: undefined,
      provider: undefined,
      model: undefined,
      productFamily: "language",
      chargeType: undefined,
    });
  });

  test.each([...PRICING_BILLING_SOURCES])(
    "accepts canonical billingSource=%s",
    async (billingSource) => {
      const response = await request(`?billingSource=${billingSource}`);
      expect(response.status).toBe(200);
      expect(listPersistedPricingEntries).toHaveBeenCalledWith(
        expect.objectContaining({ billingSource }),
      );
    },
  );

  test.each([...PRICING_PRODUCT_FAMILIES])(
    "accepts canonical productFamily=%s",
    async (productFamily) => {
      const response = await request(`?productFamily=${productFamily}`);
      expect(response.status).toBe(200);
      expect(listPersistedPricingEntries).toHaveBeenCalledWith(
        expect.objectContaining({ productFamily }),
      );
    },
  );

  test.each(["GATEWAY", "foo", "1e2"])(
    "rejects billingSource=%s before the pricing catalog",
    async (token) => {
      const response = await request(`?billingSource=${token}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_billing_source");
      expect(listPersistedPricingEntries).not.toHaveBeenCalled();
      expect(listRecentPricingRefreshRuns).not.toHaveBeenCalled();
    },
  );

  test.each(["LANGUAGE", "foo", "1e2"])(
    "rejects productFamily=%s before the pricing catalog",
    async (token) => {
      const response = await request(`?productFamily=${token}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_product_family");
      expect(listPersistedPricingEntries).not.toHaveBeenCalled();
      expect(listRecentPricingRefreshRuns).not.toHaveBeenCalled();
    },
  );
});
