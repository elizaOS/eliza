/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const checkoutCreate = mock(async () => ({
  id: "cs_1",
  url: "https://checkout.stripe.test/session",
}));

mock.module("@/lib/auth/service-key-hono-worker", () => ({
  requireServiceKey: async () => undefined,
  validateServiceKey: async () => null,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
    email: "u@example.com",
    organization: { stripe_customer_id: "cus_1", name: "Org" },
  }),
}));

mock.module("@/db/helpers", () => ({
  dbRead: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
  },
}));

mock.module("@/lib/services/users", () => ({
  usersService: { getWithOrganization: async () => null },
}));

mock.module("@/lib/services/organizations", () => ({
  organizationsService: { update: async () => undefined },
}));

mock.module("@/lib/security/redirect-validation", () => ({
  getDefaultPlatformRedirectOrigins: () => ["https://example.test"],
  assertAllowedAbsoluteRedirectUrl: (url: string) => new URL(url),
}));

mock.module("@/lib/stripe", () => ({
  requireStripe: () => ({
    checkout: { sessions: { create: checkoutCreate } },
    customers: { create: async () => ({ id: "cus_created" }) },
  }),
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, error: () => undefined },
}));

const { default: app } = await import("./route");

const validBody = {
  credits: 5,
  success_url: "https://example.test/ok",
  cancel_url: "https://example.test/cancel",
};

describe("POST /api/v1/credits/checkout malformed JSON", () => {
  test("returns 400 instead of 500 and never creates a session", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  test("canonical JSON still creates a checkout session", async () => {
    const response = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      },
      {},
    );
    expect(response.status).toBe(200);
    expect(checkoutCreate).toHaveBeenCalled();
  });
});
