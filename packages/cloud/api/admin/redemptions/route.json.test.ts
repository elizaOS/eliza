/** Verifies the admin redemption JSON boundary with deterministic service mocks. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const approveRedemption = mock(async () => ({ success: true }));
const requireAdmin = mock(async () => ({
  user: { id: "admin-1" },
  role: "super_admin",
}));

mock.module("@/db/repositories/token-redemptions", () => ({
  tokenRedemptionsRepository: {
    listForAdmin: async () => [],
    countByStatusForAdmin: async () => [],
  },
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({ requireAdmin }));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {}, STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/services/token-redemption-secure", () => ({
  secureTokenRedemptionService: { approveRedemption },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, error: () => undefined },
}));

const { default: app } = await import("./route");

const CANONICAL_ID = "11111111-1111-4111-8111-111111111111";

describe("POST /api/admin/redemptions malformed JSON", () => {
  beforeEach(() => {
    approveRedemption.mockClear();
  });

  test("returns 400 instead of 500 and never approves", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(approveRedemption).not.toHaveBeenCalled();
  });

  test("canonical JSON still approves the redemption", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redemptionId: CANONICAL_ID,
        action: "approve",
      }),
    });
    expect(response.status).toBe(200);
    expect(approveRedemption).toHaveBeenCalled();
  });
});
