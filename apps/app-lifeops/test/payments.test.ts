import { describe, expect, test } from "vitest";
import {
  detectRecurringCharges,
  normalizeMerchant,
} from "../src/lifeops/payment-recurrence.js";
import { parseTransactionsCsv } from "../src/lifeops/payment-csv-import.js";
import type { LifeOpsPaymentTransaction } from "../src/lifeops/payment-types.js";

function txn(
  overrides: Partial<LifeOpsPaymentTransaction> & {
    postedAt: string;
    amountUsd: number;
    merchant: string;
  },
): LifeOpsPaymentTransaction {
  return {
    id: overrides.id ?? `${overrides.merchant}-${overrides.postedAt}`,
    agentId: "agent-1",
    sourceId: overrides.sourceId ?? "src-1",
    externalId: null,
    postedAt: overrides.postedAt,
    amountUsd: overrides.amountUsd,
    direction: overrides.direction ?? "debit",
    merchantRaw: overrides.merchantRaw ?? overrides.merchant,
    merchantNormalized: overrides.merchantNormalized ?? normalizeMerchant(overrides.merchant),
    description: overrides.description ?? null,
    category: overrides.category ?? null,
    currency: overrides.currency ?? "USD",
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? overrides.postedAt,
  };
}

describe("normalizeMerchant", () => {
  test("strips TLDs, reference numbers, state codes", () => {
    expect(normalizeMerchant("NETFLIX.COM 866-579-7172 CA")).toBe("netflix");
    expect(normalizeMerchant("NETFLIX.COM   #8432")).toBe("netflix");
    expect(normalizeMerchant("Netflix Monthly 11.99")).toBe("netflix monthly");
  });

  test("collapses multi-word merchants to first three tokens", () => {
    expect(normalizeMerchant("PAYPAL *SPOTIFYUSA 402-935-7733")).toBe(
      "paypal spotifyusa",
    );
  });

  test("returns empty string for pure noise", () => {
    expect(normalizeMerchant("$12.99 POS 8432")).toBe("");
  });
});

describe("detectRecurringCharges", () => {
  test("detects monthly Netflix charges with stable cadence", () => {
    const transactions = [
      txn({
        postedAt: "2026-01-15T00:00:00Z",
        amountUsd: 15.49,
        merchant: "Netflix.com",
      }),
      txn({
        postedAt: "2026-02-14T00:00:00Z",
        amountUsd: 15.49,
        merchant: "Netflix.com",
      }),
      txn({
        postedAt: "2026-03-15T00:00:00Z",
        amountUsd: 15.49,
        merchant: "Netflix.com",
      }),
      txn({
        postedAt: "2026-04-15T00:00:00Z",
        amountUsd: 15.49,
        merchant: "Netflix.com",
      }),
    ];
    const charges = detectRecurringCharges(transactions);
    expect(charges).toHaveLength(1);
    expect(charges[0].merchantNormalized).toBe("netflix");
    expect(charges[0].cadence).toBe("monthly");
    expect(charges[0].averageAmountUsd).toBeCloseTo(15.49, 2);
    expect(charges[0].annualizedCostUsd).toBeCloseTo(15.49 * 12, 2);
    expect(charges[0].occurrenceCount).toBe(4);
    expect(charges[0].confidence).toBeGreaterThan(0.6);
  });

  test("detects annual subscriptions", () => {
    const transactions = [
      txn({
        postedAt: "2024-04-15T00:00:00Z",
        amountUsd: 120,
        merchant: "NYTIMES.COM",
      }),
      txn({
        postedAt: "2025-04-14T00:00:00Z",
        amountUsd: 120,
        merchant: "NYTIMES.COM",
      }),
      txn({
        postedAt: "2026-04-15T00:00:00Z",
        amountUsd: 120,
        merchant: "NYTIMES.COM",
      }),
    ];
    const charges = detectRecurringCharges(transactions);
    expect(charges[0].cadence).toBe("annual");
    expect(charges[0].annualizedCostUsd).toBe(120);
  });

  test("does NOT flag one-off merchants as recurring", () => {
    const transactions = [
      txn({
        postedAt: "2026-04-01T00:00:00Z",
        amountUsd: 87.34,
        merchant: "WHOLE FOODS",
      }),
    ];
    const charges = detectRecurringCharges(transactions);
    expect(charges).toHaveLength(0);
  });

  test("filters out irregular merchants with wildly different amounts", () => {
    const transactions = [
      txn({
        postedAt: "2026-01-05T00:00:00Z",
        amountUsd: 15,
        merchant: "AMAZON",
      }),
      txn({
        postedAt: "2026-01-12T00:00:00Z",
        amountUsd: 120,
        merchant: "AMAZON",
      }),
      txn({
        postedAt: "2026-02-01T00:00:00Z",
        amountUsd: 8,
        merchant: "AMAZON",
      }),
    ];
    const charges = detectRecurringCharges(transactions);
    // Amazon hit three times with very different amounts — detector should
    // either skip it or mark as irregular + low-confidence.
    const amazon = charges.find((c) => c.merchantNormalized === "amazon");
    if (amazon) {
      expect(amazon.cadence).not.toBe("monthly");
    }
  });

  test("ignores credits (incoming transactions)", () => {
    const transactions = [
      txn({
        postedAt: "2026-01-15T00:00:00Z",
        amountUsd: 2000,
        merchant: "PAYROLL",
        direction: "credit",
      }),
      txn({
        postedAt: "2026-02-14T00:00:00Z",
        amountUsd: 2000,
        merchant: "PAYROLL",
        direction: "credit",
      }),
    ];
    const charges = detectRecurringCharges(transactions);
    expect(charges).toHaveLength(0);
  });
});

describe("parseTransactionsCsv", () => {
  test("parses a standard bank-export CSV with Date/Description/Amount", () => {
    const csv =
      "Date,Description,Amount\n" +
      "2026-04-01,NETFLIX.COM,-15.49\n" +
      "2026-04-02,WHOLE FOODS,-87.34\n" +
      "2026-04-03,PAYCHECK,2000.00\n";
    const result = parseTransactionsCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.transactions).toHaveLength(3);
    expect(result.transactions[0].merchantRaw).toBe("NETFLIX.COM");
    expect(result.transactions[0].amountUsd).toBeCloseTo(15.49, 2);
    expect(result.transactions[0].direction).toBe("debit");
    expect(result.transactions[2].direction).toBe("credit");
    expect(result.transactions[2].amountUsd).toBeCloseTo(2000, 2);
  });

  test("parses CSVs with separate Debit and Credit columns", () => {
    const csv =
      "Posted Date,Payee,Debit,Credit\n" +
      "04/01/2026,NETFLIX,15.49,\n" +
      "04/03/2026,PAYCHECK,,2000.00\n";
    const result = parseTransactionsCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].direction).toBe("debit");
    expect(result.transactions[1].direction).toBe("credit");
  });

  test("handles accounting-style negative amounts in parentheses", () => {
    const csv =
      "Date,Description,Amount\n" + "2026-04-01,NETFLIX,(15.49)\n";
    const result = parseTransactionsCsv(csv);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].direction).toBe("debit");
    expect(result.transactions[0].amountUsd).toBeCloseTo(15.49, 2);
  });

  test("handles quoted fields with embedded commas", () => {
    const csv =
      'Date,Description,Amount\n' +
      '2026-04-01,"NETFLIX, INC.",-15.49\n';
    const result = parseTransactionsCsv(csv);
    expect(result.transactions[0].merchantRaw).toBe("NETFLIX, INC.");
  });

  test("reports errors for empty CSV", () => {
    const result = parseTransactionsCsv("");
    expect(result.transactions).toHaveLength(0);
    expect(result.errors[0]).toMatch(/no data rows/i);
  });

  test("reports errors for missing columns", () => {
    const csv = "Foo,Bar\n1,2\n";
    const result = parseTransactionsCsv(csv);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.transactions).toHaveLength(0);
  });
});
