/**
 * Unit tests for recurring-charge detection (`detectRecurringCharges`) and
 * merchant normalization (`normalizeMerchant`) — grouping transaction variants
 * by merchant and inferring monthly/annual cadence. Pure functions, no I/O.
 */

import { describe, expect, it } from "vitest";
import {
  detectRecurringCharges,
  normalizeMerchant,
} from "./payment-recurrence.js";
import type { LifeOpsPaymentTransaction } from "./payment-types.js";

let seq = 0;
function tx(
  over: Partial<LifeOpsPaymentTransaction> & {
    postedAt: string;
    amountUsd: number;
    merchantNormalized: string;
  },
): LifeOpsPaymentTransaction {
  seq += 1;
  return {
    id: `tx-${seq}`,
    agentId: "a",
    sourceId: "s1",
    externalId: null,
    direction: "debit",
    merchantRaw: over.merchantNormalized.toUpperCase(),
    description: null,
    category: null,
    currency: "USD",
    metadata: {},
    createdAt: over.postedAt,
    ...over,
  };
}

/** Three monthly debits ~30 days apart, same amount, for one merchant. */
function monthly(
  merchant: string,
  amount: number,
): LifeOpsPaymentTransaction[] {
  return [
    tx({
      postedAt: "2026-01-01T00:00:00Z",
      amountUsd: -amount,
      merchantNormalized: merchant,
    }),
    tx({
      postedAt: "2026-01-31T00:00:00Z",
      amountUsd: -amount,
      merchantNormalized: merchant,
    }),
    tx({
      postedAt: "2026-03-02T00:00:00Z",
      amountUsd: -amount,
      merchantNormalized: merchant,
    }),
  ];
}

describe("normalizeMerchant", () => {
  it("collapses bank-feed noise to the brand identity", () => {
    expect(normalizeMerchant("NETFLIX.COM 866-579-7172 CA")).toBe("netflix");
    expect(normalizeMerchant("NETFLIX.COM   #8432")).toBe("netflix");
    expect(normalizeMerchant("Netflix Monthly 11.99")).toBe("netflix monthly");
  });

  it("returns empty for pure noise and caps at 3 tokens", () => {
    expect(normalizeMerchant("12345 #99 $5.00")).toBe("");
    expect(normalizeMerchant("alpha beta gamma delta epsilon")).toBe(
      "alpha beta gamma",
    );
  });
});

describe("detectRecurringCharges", () => {
  it("detects a monthly subscription with cadence + annualized cost", () => {
    const charges = detectRecurringCharges(monthly("netflix", 9.99));
    expect(charges).toHaveLength(1);
    const c = charges[0];
    if (!c) {
      throw new Error("Expected a recurring charge");
    }
    expect(c.merchantNormalized).toBe("netflix");
    expect(c.cadence).toBe("monthly");
    expect(c.occurrenceCount).toBe(3);
    expect(c.averageAmountUsd).toBeCloseTo(9.99, 2);
    expect(c.annualizedCostUsd).toBeCloseTo(9.99 * 12, 1);
    expect(c.confidence).toBeGreaterThan(0.5);
    expect(c.nextExpectedAt).not.toBeNull();
    expect(c.firstSeenAt).toBe("2026-01-01T00:00:00Z");
    expect(c.latestSeenAt).toBe("2026-03-02T00:00:00Z");
  });

  it("ignores credits and single-occurrence merchants", () => {
    const credits = monthly("netflix", 9.99).map((t) => ({
      ...t,
      direction: "credit" as const,
    }));
    expect(detectRecurringCharges(credits)).toEqual([]);
    expect(
      detectRecurringCharges([
        tx({
          postedAt: "2026-01-01T00:00:00Z",
          amountUsd: -9.99,
          merchantNormalized: "once",
        }),
      ]),
    ).toEqual([]);
  });

  it("ranks charges by annualized cost descending", () => {
    const charges = detectRecurringCharges([
      ...monthly("spotify", 4.99),
      ...monthly("netflix", 19.99),
    ]);
    expect(charges.map((c) => c.merchantNormalized)).toEqual([
      "netflix",
      "spotify",
    ]);
  });

  it("skips irregular merchants with dissimilar amounts (e.g. one-off shopping)", () => {
    // Intervals (18d, 72d) average ~45d — outside every cadence band → irregular;
    // amounts 10/480/3 are dissimilar → below the 0.7 similarity floor → skipped.
    const charges = detectRecurringCharges([
      tx({
        postedAt: "2026-01-01T00:00:00Z",
        amountUsd: -10,
        merchantNormalized: "amazon",
      }),
      tx({
        postedAt: "2026-01-19T00:00:00Z",
        amountUsd: -480,
        merchantNormalized: "amazon",
      }),
      tx({
        postedAt: "2026-04-01T00:00:00Z",
        amountUsd: -3,
        merchantNormalized: "amazon",
      }),
    ]);
    expect(charges).toEqual([]);
  });

  it("prefers the raw merchant string for display", () => {
    const txns = monthly("netflix", 9.99).map((t) => ({
      ...t,
      merchantRaw: "  NETFLIX.COM  ",
    }));
    expect(detectRecurringCharges(txns)[0]?.merchantDisplay).toBe(
      "NETFLIX.COM",
    );
  });
});
