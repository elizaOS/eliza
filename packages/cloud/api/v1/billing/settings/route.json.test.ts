/** Verifies the billing-settings JSON boundary with deterministic service mocks. */
import { describe, expect, mock, test } from "bun:test";

const updateSettings = mock(async () => undefined);
class MockAutoTopUpSettingsValidationError extends Error {}

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));

mock.module("@/db/repositories", () => ({
  organizationsRepository: {
    findById: async () => ({ id: "org-1", pay_as_you_go_from_earnings: false }),
    update: async () => undefined,
  },
}));

mock.module("@/lib/services/auto-top-up", () => ({
  AUTO_TOP_UP_LIMITS: {
    MIN_AMOUNT: 1,
    MAX_AMOUNT: 1000,
    MIN_THRESHOLD: 0,
    MAX_THRESHOLD: 1000,
  },
  AutoTopUpSettingsValidationError: MockAutoTopUpSettingsValidationError,
  autoTopUpService: {
    getSettings: async () => ({
      enabled: false,
      amount: null,
      threshold: null,
      hasPaymentMethod: true,
    }),
    updateSettings,
  },
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: { windowMs: 60_000, maxRequests: 100 } },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  },
}));

const { default: app } = await import("./route");

describe("PUT /api/v1/billing/settings malformed JSON", () => {
  test("returns 400 instead of 500 and never writes settings", async () => {
    const response = await app.request("/", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  test("canonical JSON still updates settings", async () => {
    const response = await app.fetch(
      new Request("http://internal/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoTopUp: { enabled: false } }),
      }),
    );
    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalled();
  });
});
