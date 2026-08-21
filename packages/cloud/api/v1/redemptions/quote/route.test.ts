/**
 * GET /api/v1/redemptions/quote pointsAmount contract at the HTTP boundary.
 *
 * The harness is deterministic: auth, rate-limit, payout status, TWAP, and
 * token-availability collaborators are stubbed so a 400 can be proven
 * write-free. Prefix-coercible garbage must not reach those services.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const USER_ID = "00000000-0000-4000-8000-000000142390";
const ORG_ID = "00000000-0000-4000-8000-000000142391";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: USER_ID,
  organization_id: ORG_ID,
}));
const isNetworkAvailable = mock(async () => ({
  available: true,
  message: "",
}));
const getStatus = mock(async () => ({ networks: [] }));
const getRedemptionQuote = mock(
  async (_network: string, pointsAmount: number) => ({
    success: true,
    quote: {
      usdValue: pointsAmount / 100,
      twapPrice: 0.01,
      spotPrice: 0.01,
      sampleCount: 10,
      volatility: 0.01,
      requiresDelay: false,
      delayUntil: undefined,
      expiresAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    warnings: [],
  }),
);
const checkTokenAvailability = mock(async () => ({
  available: true,
  balance: 1_000,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/services/payout-status", () => ({
  payoutStatusService: {
    isNetworkAvailable,
    getStatus,
  },
}));

mock.module("@/lib/services/twap-price-oracle", () => ({
  twapPriceOracle: { getRedemptionQuote },
}));

mock.module("@/lib/services/eliza-token-price", () => ({
  ELIZA_TOKEN_ADDRESSES: {
    ethereum: "0xethereum",
    base: "0xbase",
    bnb: "0xbnb",
    solana: "solana",
  },
}));

mock.module("@/lib/services/token-redemption-secure", () => ({
  secureTokenRedemptionService: { checkTokenAvailability },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { default: app, parseRedemptionQuotePointsAmount } = await import(
  "./route"
);

function quoteRequest(query: string) {
  return app.request(`/${query}`, { method: "GET" });
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockClear();
  isNetworkAvailable.mockClear();
  getStatus.mockClear();
  getRedemptionQuote.mockClear();
  checkTokenAvailability.mockClear();
});

function expectNoQuoteSideEffects() {
  expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
  expect(isNetworkAvailable).not.toHaveBeenCalled();
  expect(getRedemptionQuote).not.toHaveBeenCalled();
  expect(checkTokenAvailability).not.toHaveBeenCalled();
}

describe("parseRedemptionQuotePointsAmount", () => {
  test.each([
    [undefined, 100],
    ["", 100],
    ["100", 100],
    ["100000", 100_000],
  ] as const)("accepts %s", (raw, expected) => {
    expect(parseRedemptionQuotePointsAmount(raw)).toEqual({
      ok: true,
      pointsAmount: expected,
    });
  });

  test.each([
    ["1e4", "scientific notation"],
    ["100abc", "trailing junk"],
    ["0x10", "hex"],
    ["0100", "leading zeros"],
    ["+100", "plus sign"],
    ["-1", "signed"],
    ["100.0", "decimal"],
    [" 100", "leading whitespace"],
    ["100 ", "trailing whitespace"],
    ["1_000", "separator"],
    ["0", "zero"],
    ["1", "below redemption minimum"],
    ["99", "below redemption minimum"],
    ["100001", "above redemption maximum"],
    ["Infinity", "Infinity"],
    ["NaN", "NaN"],
    [" ", "whitespace only"],
    ["9007199254740992", "above safe integer"],
  ] as const)("rejects %s (%s)", (raw) => {
    expect(parseRedemptionQuotePointsAmount(raw)).toEqual({ ok: false });
  });
});

describe("GET /api/v1/redemptions/quote — pointsAmount contract", () => {
  test("absent pointsAmount defaults to 100 before any quote service", async () => {
    const res = await quoteRequest("?network=base");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      quote: { asset: string; pointsAmount: number };
    };
    expect(body.success).toBe(true);
    expect(body.quote.asset).toBe("eliza");
    expect(body.quote.pointsAmount).toBe(100);
    expect(getRedemptionQuote).toHaveBeenCalledTimes(1);
    expect(getRedemptionQuote).toHaveBeenCalledWith("base", 100, USER_ID);
  });

  test("empty pointsAmount defaults to 100", async () => {
    const res = await quoteRequest("?network=base&pointsAmount=");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      quote: { pointsAmount: number };
    };
    expect(body.quote.pointsAmount).toBe(100);
    expect(getRedemptionQuote).toHaveBeenCalledWith("base", 100, USER_ID);
  });

  test.each([
    ["100", 100],
    ["2500", 2500],
    ["100000", 100_000],
  ] as const)(
    "canonical pointsAmount %s is forwarded unchanged",
    async (raw, expected) => {
      const res = await quoteRequest(`?network=base&pointsAmount=${raw}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        quote: { pointsAmount: number };
      };
      expect(body.quote.pointsAmount).toBe(expected);
      expect(getRedemptionQuote).toHaveBeenCalledWith(
        "base",
        expected,
        USER_ID,
      );
      expect(isNetworkAvailable).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    ["1e4", "scientific notation that parseInt truncates to 1"],
    ["100abc", "trailing junk that parseInt accepts as 100"],
    ["0x10", "hex"],
    ["0100", "leading zeros"],
    ["+100", "plus sign"],
    ["-1", "signed"],
    ["100.0", "decimal that parseInt truncates"],
    [" 100", "leading whitespace"],
    ["100 ", "trailing whitespace"],
    ["1_000", "numeric separator"],
    ["0", "zero"],
    ["1", "below redemption minimum"],
    ["99", "below redemption minimum"],
    ["100001", "above redemption maximum"],
    ["Infinity", "Infinity"],
    ["NaN", "NaN"],
    ["9007199254740992", "unsafe integer"],
  ] as const)(
    "returns 400 and calls no quote services for %s (%s)",
    async (raw) => {
      const res = await quoteRequest(
        `?network=base&pointsAmount=${encodeURIComponent(raw)}`,
      );
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        success: false,
        error: "Invalid pointsAmount",
      });
      expectNoQuoteSideEffects();
    },
  );
});
