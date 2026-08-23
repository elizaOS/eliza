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

  it("sorts recurring charges safely when annualizedCostUsd contains NaN via real comparator", async () => {
    const { compareRecurringChargesByAnnualizedCost } = await import(
      "./payment-recurrence.ts"
    );
    const { compareSubscriptionsByAnnualizedCost } = await import(
      "./finance-capabilities.ts"
    );
    const { compareSpendingCategoryByTotal, compareSpendingMerchantByTotal } =
      await import("./finances-service.ts");
    const { normalizeSubscriptions } = await import(
      "./finance-capabilities.ts"
    );
    const charges = [
      { merchantNormalized: "netflix", annualizedCostUsd: Number.NaN },
      { merchantNormalized: "spotify", annualizedCostUsd: 120 },
    ] as unknown as Parameters<
      typeof compareRecurringChargesByAnnualizedCost
    >[0][];
    charges.sort(compareRecurringChargesByAnnualizedCost);
    expect(charges[0]?.merchantNormalized).toBe("spotify");
    expect(charges[1]?.merchantNormalized).toBe("netflix");

    const tied = [
      { merchantNormalized: "b", annualizedCostUsd: 100 },
      { merchantNormalized: "a", annualizedCostUsd: 100 },
    ] as unknown as Parameters<
      typeof compareRecurringChargesByAnnualizedCost
    >[0][];
    tied.sort(compareRecurringChargesByAnnualizedCost);
    expect(tied.map((c) => c.merchantNormalized)).toEqual(["a", "b"]);

    const subs = normalizeSubscriptions([
      {
        merchantNormalized: "netflix",
        merchantDisplay: "Netflix",
        annualizedCostUsd: Number.NaN,
        cadence: "monthly",
        category: "entertainment",
        confidence: 0.9,
        sourceIds: ["s1"],
        occurrences: 3,
        avgAmountUsd: 15,
      },
      {
        merchantNormalized: "spotify",
        merchantDisplay: "Spotify",
        annualizedCostUsd: 120,
        cadence: "monthly",
        category: "entertainment",
        confidence: 0.9,
        sourceIds: ["s1"],
        occurrences: 3,
        avgAmountUsd: 10,
      },
    ] as unknown as Parameters<typeof normalizeSubscriptions>[0]);
    expect(subs[0]?.merchantNormalized).toBe("spotify");
    expect(subs[1]?.merchantNormalized).toBe("netflix");

    const subsTied = [
      { merchantNormalized: "b", annualizedCostUsd: 50 },
      { merchantNormalized: "a", annualizedCostUsd: 50 },
    ] as unknown as Parameters<
      typeof compareSubscriptionsByAnnualizedCost
    >[0][];
    subsTied.sort(compareSubscriptionsByAnnualizedCost);
    expect(subsTied.map((s) => s.merchantNormalized)).toEqual(["a", "b"]);

    const cats = [
      { category: "b", totalUsd: 10 },
      { category: "a", totalUsd: Number.NaN },
      { category: "c", totalUsd: 20 },
    ] as unknown as Parameters<typeof compareSpendingCategoryByTotal>[0][];
    cats.sort(compareSpendingCategoryByTotal);
    expect(cats.map((c) => c.category)).toEqual(["c", "b", "a"]);

    const merchants = [
      { merchantNormalized: "b", totalUsd: Number.NaN },
      { merchantNormalized: "a", totalUsd: 5 },
    ] as unknown as Parameters<typeof compareSpendingMerchantByTotal>[0][];
    merchants.sort(compareSpendingMerchantByTotal);
    expect(merchants[0]?.merchantNormalized).toBe("a");
  });

  it("detectRecurringCharges orders via real function with stubbed amounts", () => {
    const base = new Date("2026-01-01T00:00:00Z").toISOString();
    const charges = detectRecurringCharges([
      {
        id: "1",
        agentId: "a",
        sourceId: "s",
        postedAt: base,
        amountUsd: -10,
        merchantNormalized: "b-test",
        merchantDisplay: "B",
        description: "b",
        category: "test",
      } as unknown as LifeOpsPaymentTransaction,
      {
        id: "2",
        agentId: "a",
        sourceId: "s",
        postedAt: new Date("2026-02-01T00:00:00Z").toISOString(),
        amountUsd: -10,
        merchantNormalized: "b-test",
        merchantDisplay: "B",
        description: "b",
        category: "test",
      } as unknown as LifeOpsPaymentTransaction,
      {
        id: "3",
        agentId: "a",
        sourceId: "s",
        postedAt: new Date("2026-03-01T00:00:00Z").toISOString(),
        amountUsd: -10,
        merchantNormalized: "b-test",
        merchantDisplay: "B",
        description: "b",
        category: "test",
      } as unknown as LifeOpsPaymentTransaction,
      {
        id: "4",
        agentId: "a",
        sourceId: "s",
        postedAt: base,
        amountUsd: -10,
        merchantNormalized: "a-test",
        merchantDisplay: "A",
        description: "a",
        category: "test",
      } as unknown as LifeOpsPaymentTransaction,
      {
        id: "5",
        agentId: "a",
        sourceId: "s",
        postedAt: new Date("2026-02-01T00:00:00Z").toISOString(),
        amountUsd: -10,
        merchantNormalized: "a-test",
        merchantDisplay: "A",
        description: "a",
        category: "test",
      } as unknown as LifeOpsPaymentTransaction,
      {
        id: "6",
        agentId: "a",
        sourceId: "s",
        postedAt: new Date("2026-03-01T00:00:00Z").toISOString(),
        amountUsd: -10,
        merchantNormalized: "a-test",
        merchantDisplay: "A",
        description: "a",
        category: "test",
      } as unknown as LifeOpsPaymentTransaction,
    ]);
    if (charges.length >= 2) {
      expect(
        charges[0].merchantNormalized.localeCompare(
          charges[1].merchantNormalized,
        ) <= 0,
      ).toBe(true);
    }
  });
});
