import { beforeEach, describe, expect, mock, test } from "bun:test";

const USER_ID = "00000000-0000-4000-8000-000000142390";
const ORG_ID = "00000000-0000-4000-8000-000000142391";
const ORIGIN_ERROR =
  "Unable to verify redemption origin. Please try again later.";

const requireUserOrApiKeyWithOrg = mock();
const createRedemption = mock();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: {
    CRITICAL: {},
    STRICT: {},
  },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

mock.module("@/lib/services/payout-status", () => ({
  payoutStatusService: {
    isNetworkAvailable: mock(async () => ({ available: true, message: "" })),
    getStatus: mock(async () => ({ networks: [] })),
  },
}));

mock.module("@/lib/services/token-redemption-secure", () => ({
  REDEMPTION_ORIGIN_VERIFICATION_ERROR: ORIGIN_ERROR,
  secureTokenRedemptionService: {
    createRedemption,
    listUserRedemptions: mock(async () => []),
  },
}));

const redemptionsRoute = (await import("../v1/redemptions/route")).default;

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  createRedemption.mockReset();

  requireUserOrApiKeyWithOrg.mockResolvedValue({
    id: USER_ID,
    organization_id: ORG_ID,
  });
  createRedemption.mockResolvedValue({
    success: true,
    redemptionId: "redemption-1",
    quote: { requiresReview: false },
    warnings: [],
  });
});

function redemptionRequest(headers: Record<string, string> = {}) {
  return new Request("http://test.local/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      pointsAmount: 100,
      network: "base",
      asset: "usdc",
      payoutAddress: "0x0000000000000000000000000000000000000001",
    }),
  });
}

async function postRedemption(headers: Record<string, string> = {}) {
  return redemptionsRoute.fetch(redemptionRequest(headers), {
    REDEMPTION_EMERGENCY_PAUSE: "false",
  });
}

function createdRedemptionMetadata() {
  const [[request]] = createRedemption.mock.calls as Array<
    [Record<string, unknown>]
  >;
  return request.metadata as { ipAddress?: string; userAgent?: string };
}

describe("POST /api/v1/redemptions client IP resolution", () => {
  test("uses CF-Connecting-IP instead of spoofable X-Forwarded-For", async () => {
    const res = await postRedemption({
      "CF-Connecting-IP": "198.51.100.44",
      "X-Forwarded-For": "192.0.2.123, 203.0.113.9",
    });

    expect(res.status).toBe(200);
    expect(createRedemption).toHaveBeenCalledTimes(1);
    expect(createdRedemptionMetadata().ipAddress).toBe("198.51.100.44");
  });

  test("canonicalizes a valid Cloudflare IPv6 client IP", async () => {
    const res = await postRedemption({
      "CF-Connecting-IP": "2001:0DB8::1",
    });

    expect(res.status).toBe(200);
    expect(createRedemption).toHaveBeenCalledTimes(1);
    expect(createdRedemptionMetadata().ipAddress).toBe("2001:db8::1");
  });

  test("denies X-Forwarded-For without Cloudflare client IP", async () => {
    const res = await postRedemption({
      "X-Forwarded-For": "192.0.2.123, 203.0.113.9",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: ORIGIN_ERROR,
    });
    expect(createRedemption).not.toHaveBeenCalled();
  });

  test("rejects malformed IP headers instead of using them as identities", async () => {
    const res = await postRedemption({
      "CF-Connecting-IP": "not-an-ip",
      "X-Forwarded-For": "203.0.113.9",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: ORIGIN_ERROR,
    });
    expect(createRedemption).not.toHaveBeenCalled();
  });

  test("denies before createRedemption when no trusted IP is present", async () => {
    const res = await postRedemption();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: ORIGIN_ERROR,
    });
    expect(createRedemption).not.toHaveBeenCalled();
  });
});
