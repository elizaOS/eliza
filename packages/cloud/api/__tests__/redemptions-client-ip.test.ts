/**
 * POST redemption boundary coverage for trusted client identity and the shared
 * request/response transport contract.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const USER_ID = "00000000-0000-4000-8000-000000142390";
const ORG_ID = "00000000-0000-4000-8000-000000142391";
const ORIGIN_ERROR =
  "Unable to verify redemption origin. Please try again later.";

const requireUserOrApiKeyWithOrg = mock();
const createRedemption = mock();
const replayRedemption = mock(async (): Promise<unknown> => null);
const listUserRedemptions = mock(
  async (): Promise<Array<Record<string, unknown>>> => [],
);
const isNetworkAvailable = mock();
const getPayoutStatus = mock();

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
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

mock.module("@/lib/services/payout-status", () => ({
  payoutStatusService: {
    isNetworkAvailable,
    getStatus: getPayoutStatus,
  },
}));

mock.module("@/lib/services/token-redemption-secure", () => ({
  REDEMPTION_ORIGIN_VERIFICATION_ERROR: ORIGIN_ERROR,
  secureTokenRedemptionService: {
    createRedemption,
    replayRedemption,
    listUserRedemptions,
  },
}));

const redemptionsRoute = (await import("../v1/redemptions/route")).default;

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  createRedemption.mockReset();
  replayRedemption.mockReset();
  listUserRedemptions.mockReset();
  isNetworkAvailable.mockReset();
  getPayoutStatus.mockReset();

  requireUserOrApiKeyWithOrg.mockResolvedValue({
    id: USER_ID,
    organization_id: ORG_ID,
  });
  createRedemption.mockResolvedValue({
    success: true,
    redemptionId: "redemption-1",
    quote: {
      pointsAmount: 100,
      usdValue: "1.00",
      elizaPriceUsd: "0.25",
      elizaAmount: "4.00",
      asset: "usdc",
      network: "base",
      payoutAddress: "0x0000000000000000000000000000000000000001",
      expiresAt: new Date("2026-08-20T12:02:00.000Z"),
      requiresReview: false,
    },
    warnings: [],
  });
  replayRedemption.mockResolvedValue(null);
  listUserRedemptions.mockResolvedValue([]);
  isNetworkAvailable.mockResolvedValue({ available: true, message: "" });
  getPayoutStatus.mockResolvedValue({ networks: [] });
});

function redemptionRequest(
  headers: Record<string, string> = {},
  bodyOverrides: Record<string, unknown> = {},
) {
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
      ...bodyOverrides,
    }),
  });
}

async function postRedemption(
  headers: Record<string, string> = {},
  bodyOverrides: Record<string, unknown> = {},
  envOverrides: Record<string, string> = {},
) {
  return redemptionsRoute.fetch(redemptionRequest(headers, bodyOverrides), {
    REDEMPTION_EMERGENCY_PAUSE: "false",
    ...envOverrides,
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
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body).toEqual({
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
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body).toEqual({
      success: false,
      error: ORIGIN_ERROR,
    });
    expect(createRedemption).not.toHaveBeenCalled();
  });

  test("denies before createRedemption when no trusted IP is present", async () => {
    const res = await postRedemption();

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body).toEqual({
      success: false,
      error: ORIGIN_ERROR,
    });
    expect(createRedemption).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/redemptions transport contract", () => {
  const trustedHeaders = { "CF-Connecting-IP": "198.51.100.44" };

  test("replays an exact receipt before pause, network, and trusted-IP gates", async () => {
    const idempotencyKey = "00000000-0000-4000-8000-000000000001";
    replayRedemption.mockResolvedValue({
      success: true,
      redemptionId: "redemption-replayed",
      quote: {
        pointsAmount: 100,
        usdValue: "1.00",
        elizaPriceUsd: "0.25",
        elizaAmount: "4.00",
        asset: "eliza",
        network: "base",
        payoutAddress: "0x0000000000000000000000000000000000000001",
        expiresAt: new Date("2026-08-20T12:02:00.000Z"),
        requiresReview: true,
      },
    });
    isNetworkAvailable.mockResolvedValue({
      available: false,
      message: "Network unavailable",
    });

    const res = await postRedemption(
      {},
      { asset: "eliza", idempotencyKey },
      { REDEMPTION_EMERGENCY_PAUSE: "true" },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      redemptionId: "redemption-replayed",
      quote: {
        asset: "eliza",
        expiresAt: "2026-08-20T12:02:00.000Z",
      },
    });
    expect(replayRedemption).toHaveBeenCalledWith({
      userId: USER_ID,
      appId: undefined,
      pointsAmount: 100,
      network: "base",
      asset: "eliza",
      payoutAddress: "0x0000000000000000000000000000000000000001",
      idempotencyKey,
    });
    expect(isNetworkAvailable).not.toHaveBeenCalled();
    expect(createRedemption).not.toHaveBeenCalled();
  });

  test("rejects an idempotency-key intent mismatch before mutable gates", async () => {
    const idempotencyKey = "00000000-0000-4000-8000-000000000001";
    replayRedemption.mockResolvedValue({
      success: false,
      error:
        "Idempotency key was already used for a different redemption request.",
    });

    const res = await postRedemption(
      {},
      { idempotencyKey },
      { REDEMPTION_EMERGENCY_PAUSE: "true" },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body).toEqual({
      success: false,
      error:
        "Idempotency key was already used for a different redemption request.",
    });
    expect(isNetworkAvailable).not.toHaveBeenCalled();
    expect(createRedemption).not.toHaveBeenCalled();
  });

  test("recovers a receipt that commits while the pause gate is evaluated", async () => {
    const idempotencyKey = "00000000-0000-4000-8000-000000000001";
    replayRedemption.mockResolvedValueOnce(null).mockResolvedValueOnce({
      success: true,
      redemptionId: "redemption-concurrent",
      quote: {
        pointsAmount: 100,
        usdValue: "1.00",
        elizaPriceUsd: "0.25",
        elizaAmount: "4.00",
        asset: "eliza",
        network: "base",
        payoutAddress: "0x0000000000000000000000000000000000000001",
        expiresAt: new Date("2026-08-20T12:02:00.000Z"),
        requiresReview: true,
      },
    });

    const res = await postRedemption(
      {},
      { asset: "eliza", idempotencyKey },
      { REDEMPTION_EMERGENCY_PAUSE: "true" },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      redemptionId: "redemption-concurrent",
    });
    expect(replayRedemption).toHaveBeenCalledTimes(2);
    expect(isNetworkAvailable).not.toHaveBeenCalled();
    expect(createRedemption).not.toHaveBeenCalled();
  });

  test("does not let an unknown idempotency key bypass the emergency pause", async () => {
    const res = await postRedemption(
      {},
      { idempotencyKey: "00000000-0000-4000-8000-000000000001" },
      { REDEMPTION_EMERGENCY_PAUSE: "true" },
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, paused: true });
    expect(replayRedemption).toHaveBeenCalledTimes(2);
    expect(isNetworkAvailable).not.toHaveBeenCalled();
    expect(createRedemption).not.toHaveBeenCalled();
  });

  test("forwards pointsAmount, asset, and the idempotency UUID", async () => {
    const idempotencyKey = "00000000-0000-4000-8000-000000000001";
    const res = await postRedemption(trustedHeaders, {
      pointsAmount: 1_234,
      asset: "eliza",
      idempotencyKey,
    });

    expect(res.status).toBe(200);
    expect(createRedemption).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        pointsAmount: 1_234,
        network: "base",
        asset: "eliza",
        idempotencyKey,
        payoutAddress: "0x0000000000000000000000000000000000000001",
      }),
    );
  });

  test("prefers a concurrent durable receipt over a transient service failure", async () => {
    const idempotencyKey = "00000000-0000-4000-8000-000000000001";
    createRedemption.mockResolvedValueOnce({
      success: false,
      error: "Transient payout availability failure",
    });
    replayRedemption.mockResolvedValueOnce(null).mockResolvedValueOnce({
      success: true,
      redemptionId: "redemption-concurrent-service",
      quote: {
        pointsAmount: 100,
        usdValue: "1.00",
        elizaPriceUsd: "0.25",
        elizaAmount: "4.00",
        asset: "eliza",
        network: "base",
        payoutAddress: "0x0000000000000000000000000000000000000001",
        expiresAt: new Date("2026-08-20T12:02:00.000Z"),
        requiresReview: true,
      },
    });

    const res = await postRedemption(trustedHeaders, {
      asset: "eliza",
      idempotencyKey,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      redemptionId: "redemption-concurrent-service",
    });
    expect(createRedemption).toHaveBeenCalledTimes(1);
    expect(replayRedemption).toHaveBeenCalledTimes(2);
  });

  test("recovers a concurrent receipt after the service throws", async () => {
    const idempotencyKey = "00000000-0000-4000-8000-000000000001";
    createRedemption.mockRejectedValueOnce(
      new Error("Transient oracle failure"),
    );
    replayRedemption.mockResolvedValueOnce(null).mockResolvedValueOnce({
      success: true,
      redemptionId: "redemption-concurrent-throw",
      quote: {
        pointsAmount: 100,
        usdValue: "1.00",
        elizaPriceUsd: "0.25",
        elizaAmount: "4.00",
        asset: "eliza",
        network: "base",
        payoutAddress: "0x0000000000000000000000000000000000000001",
        expiresAt: new Date("2026-08-20T12:02:00.000Z"),
        requiresReview: true,
      },
    });

    const res = await postRedemption(trustedHeaders, {
      asset: "eliza",
      idempotencyKey,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      redemptionId: "redemption-concurrent-throw",
    });
    expect(createRedemption).toHaveBeenCalledTimes(1);
    expect(replayRedemption).toHaveBeenCalledTimes(2);
  });

  test("canonicalizes the bsc compatibility alias to bnb", async () => {
    const res = await postRedemption(trustedHeaders, {
      network: "bsc",
      asset: "eliza",
    });

    expect(res.status).toBe(200);
    expect(createRedemption).toHaveBeenCalledWith(
      expect.objectContaining({ network: "bnb", asset: "eliza" }),
    );
  });

  test("preserves the legacy omitted-asset USDC default", async () => {
    const res = await postRedemption(trustedHeaders, { asset: undefined });

    expect(res.status).toBe(200);
    expect(createRedemption).toHaveBeenCalledWith(
      expect.objectContaining({ asset: "usdc" }),
    );
  });

  test.each([
    [99, "Minimum redemption is 100 points ($1.00)"],
    [100_001, "Maximum redemption is 100,000 points ($1,000.00)"],
  ])(
    "rejects pointsAmount %i outside the inclusive bounds",
    async (pointsAmount, message) => {
      const res = await postRedemption(trustedHeaders, { pointsAmount });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        success: boolean;
        details: Array<{ field: string; message: string }>;
      };
      expect(body.success).toBe(false);
      expect(body.details).toContainEqual({ field: "pointsAmount", message });
      expect(createRedemption).not.toHaveBeenCalled();
    },
  );

  test("serializes the service quote expiry as an ISO transport string", async () => {
    const res = await postRedemption(trustedHeaders);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      redemptionId: string;
      quote: {
        expiresAt: string;
        pointsAmount: number;
        asset: string;
        network: string;
      };
    };
    expect(body).toMatchObject({
      success: true,
      redemptionId: "redemption-1",
      quote: {
        pointsAmount: 100,
        asset: "usdc",
        network: "base",
        expiresAt: "2026-08-20T12:02:00.000Z",
      },
    });
  });
});

describe("GET /api/v1/redemptions transport contract", () => {
  test("returns the canonical camelCase history item with an explicit asset", async () => {
    listUserRedemptions.mockResolvedValue([
      {
        id: "redemption-history-1",
        points_amount: "500",
        usd_value: "5.00",
        eliza_amount: "5.00",
        eliza_price_usd: "1.00",
        asset: "usdc",
        network: "base",
        payout_address: "0x0000000000000000000000000000000000000001",
        status: "completed",
        tx_hash: "0xhistory",
        created_at: new Date("2026-08-20T12:00:00.000Z"),
        completed_at: new Date("2026-08-20T12:01:00.000Z"),
        failure_reason: null,
        requires_review: false,
      },
    ]);

    const res = await redemptionsRoute.fetch(
      new Request("http://test.local/?limit=10"),
      { REDEMPTION_EMERGENCY_PAUSE: "false" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      redemptions: Array<Record<string, unknown>>;
      paused: boolean;
    };
    expect(body).toEqual({
      success: true,
      redemptions: [
        {
          id: "redemption-history-1",
          pointsAmount: 500,
          usdValue: 5,
          elizaAmount: 5,
          elizaPriceUsd: 1,
          asset: "usdc",
          network: "base",
          payoutAddress: "0x0000...0001",
          status: "completed",
          txHash: "0xhistory",
          createdAt: "2026-08-20T12:00:00.000Z",
          completedAt: "2026-08-20T12:01:00.000Z",
          failureReason: null,
          requiresReview: false,
        },
      ],
      paused: false,
    });
  });
});
