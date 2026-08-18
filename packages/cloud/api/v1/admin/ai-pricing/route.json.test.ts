/**
 * POST /api/v1/admin/ai-pricing used to let c.req.json() throw into
 * failureResponse, which maps SyntaxError to 500. Malformed JSON is caller error.
 */
import { describe, expect, mock, test } from "bun:test";

const refreshPricingCatalog = mock(async () => ({
  success: true,
  refreshed: 1,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireAdmin: async () => ({
    user: { id: "admin-1" },
    role: "admin",
  }),
}));

mock.module("@/lib/services/ai-pricing", () => ({
  buildDimensionKey: () => "dim",
  listPersistedPricingEntries: async () => [],
  listRecentPricingRefreshRuns: async () => [],
  normalizePricingDimensions: (value: unknown) => value,
  refreshPricingCatalog,
}));

mock.module("@/lib/services/ai-pricing-definitions", () => ({
  PRICING_BILLING_SOURCES: ["gateway"],
  PRICING_PRODUCT_FAMILIES: ["language"],
}));

mock.module("@/db/repositories/ai-pricing", () => ({
  aiPricingRepository: { createManualOverride: async () => ({ id: "row-1" }) },
}));

const { default: app } = await import("./route");

describe("POST /api/v1/admin/ai-pricing malformed JSON", () => {
  test("returns 400 instead of 500 and never refreshes pricing", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(refreshPricingCatalog).not.toHaveBeenCalled();
  });

  test("canonical JSON still refreshes pricing", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sources: ["gateway"] }),
    });
    expect(response.status).toBe(200);
    expect(refreshPricingCatalog).toHaveBeenCalled();
  });
});
