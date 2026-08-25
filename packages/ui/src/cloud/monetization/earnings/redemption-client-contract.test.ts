/** Unit coverage for exact redemption parsing, correlation, and request keys. */

import { describe, expect, it } from "vitest";
import {
  buildCreateRedemptionRequest,
  buildRedemptionQuotePath,
  ceilRedemptionUsdToPoints,
  createRedemptionIdempotencyKey,
  floorRedemptionUsdToPoints,
  isRedemptionQuoteExpired,
  parseRedemptionUsdToPoints,
  quoteMatchesRedemptionRequest,
} from "./redemption-client-contract";

describe("redemption client contract", () => {
  it.each([
    ["0.01", 1],
    ["1", 100],
    ["1.2", 120],
    ["1.23", 123],
    ["1000.00", 100000],
  ])("converts USD input %s to integer points %i", (value, expected) => {
    expect(parseRedemptionUsdToPoints(value)).toBe(expected);
  });

  it.each(["", "0", "00.01", ".5", "1.", "1.001", "1e2", " 1", "1 ", "-1"])(
    "rejects non-canonical USD input %s",
    (value) => {
      expect(parseRedemptionUsdToPoints(value)).toBeNull();
    },
  );

  it("uses the API's pointsAmount query field", () => {
    expect(
      buildRedemptionQuotePath({ pointsAmount: 123, network: "base" }),
    ).toBe("/api/v1/redemptions/quote?pointsAmount=123&network=base");
  });

  it("preserves the API's default $1 quote when pointsAmount is omitted", () => {
    expect(buildRedemptionQuotePath({ network: "base" })).toBe(
      "/api/v1/redemptions/quote?network=base",
    );
  });

  it.each([
    [1.15, 115],
    [1.16, 116],
    [2.05, 205],
    [1.159, 115],
  ])("floors server USD value %s to %i whole points", (value, expected) => {
    expect(floorRedemptionUsdToPoints(value)).toBe(expected);
  });

  it("ceils configured fractional-cent minimums without binary drift", () => {
    expect(ceilRedemptionUsdToPoints(1.15)).toBe(115);
    expect(ceilRedemptionUsdToPoints(1.151)).toBe(116);
  });

  it("builds the POST body with pointsAmount rather than amount", () => {
    expect(
      buildCreateRedemptionRequest({
        usdAmount: "12.34",
        network: "solana",
        payoutAddress: "11111111111111111111111111111111",
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({
      pointsAmount: 1234,
      network: "solana",
      asset: "eliza",
      payoutAddress: "11111111111111111111111111111111",
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("rejects POST amounts outside the server's inclusive bounds", () => {
    const base = {
      network: "base" as const,
      payoutAddress: "0x0000000000000000000000000000000000000002",
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
    };
    expect(buildCreateRedemptionRequest({ ...base, usdAmount: "0.99" })).toBe(
      null,
    );
    expect(
      buildCreateRedemptionRequest({ ...base, usdAmount: "1000.01" }),
    ).toBe(null);
  });

  it("keeps the supplied UUID stable in the request builder", () => {
    expect(
      createRedemptionIdempotencyKey(
        () => "00000000-0000-4000-8000-000000000002",
      ),
    ).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("correlates a quote to both points and the normalized network", () => {
    const quote = {
      success: true as const,
      quote: {
        asset: "eliza" as const,
        network: "bnb" as const,
        pointsAmount: 123,
      },
    };
    expect(
      quoteMatchesRedemptionRequest(quote, {
        pointsAmount: 123,
        network: "bsc",
      }),
    ).toBe(true);
    expect(
      quoteMatchesRedemptionRequest(quote, {
        pointsAmount: 124,
        network: "bsc",
      }),
    ).toBe(false);
    expect(
      quoteMatchesRedemptionRequest(quote, {
        pointsAmount: 123,
        network: "base",
      }),
    ).toBe(false);
    expect(
      quoteMatchesRedemptionRequest(quote, {
        pointsAmount: 123,
        network: "bsc",
        asset: "usdc",
      }),
    ).toBe(false);
  });

  it("treats invalid and elapsed quote deadlines as expired", () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    expect(isRedemptionQuoteExpired("invalid", now)).toBe(true);
    expect(isRedemptionQuoteExpired("2026-08-20T12:00:00.000Z", now)).toBe(
      true,
    );
    expect(isRedemptionQuoteExpired("2026-08-20T12:00:00.001Z", now)).toBe(
      false,
    );
  });
});
