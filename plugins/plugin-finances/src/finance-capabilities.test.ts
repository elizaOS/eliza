/**
 * Deterministic unit tests for the provider-neutral finance capability layer:
 * balance derivation, budget status, anomaly detection, subscription
 * normalization, capability metadata, and write receipts. Pure-function
 * harness — real inputs shaped like repository rows, no mocks of the system
 * under test, no I/O. Covers multi-account and multi-currency ledgers,
 * pending rows, duplicate charges, empty inputs, and adversarial merchant
 * strings.
 */

import { describe, expect, it } from "vitest";
import {
  buildCapabilityMeta,
  buildWriteReceipt,
  computeBudgetStatus,
  computeSourceBalances,
  countDistinctSources,
  detectAnomalies,
  isPendingTransaction,
  normalizeSubscriptions,
} from "./finance-capabilities.ts";
import type {
  LifeOpsPaymentSource,
  LifeOpsPaymentTransaction,
  LifeOpsRecurringCharge,
} from "./payment-types.ts";

const NOW = new Date("2026-08-20T12:00:00.000Z");

function source(
  overrides: Partial<LifeOpsPaymentSource> & { id: string },
): LifeOpsPaymentSource {
  return {
    agentId: "agent-1",
    kind: "manual",
    label: overrides.id,
    institution: null,
    accountMask: null,
    status: "active",
    lastSyncedAt: null,
    transactionCount: 0,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

let txSeq = 0;
function tx(
  overrides: Partial<LifeOpsPaymentTransaction> & {
    sourceId: string;
    postedAt: string;
    amountUsd: number;
  },
): LifeOpsPaymentTransaction {
  txSeq += 1;
  return {
    id: `tx-${txSeq}`,
    agentId: "agent-1",
    externalId: null,
    direction: "debit",
    merchantRaw: "Merchant",
    merchantNormalized: "merchant",
    description: null,
    category: null,
    currency: "USD",
    metadata: {},
    createdAt: overrides.postedAt,
    ...overrides,
  };
}

describe("computeSourceBalances", () => {
  it("derives per-source net flow across multiple accounts", () => {
    const sources = [source({ id: "a" }), source({ id: "b" })];
    const balances = computeSourceBalances(sources, [
      tx({
        sourceId: "a",
        postedAt: "2026-08-01T00:00:00.000Z",
        amountUsd: 100,
        direction: "credit",
      }),
      tx({
        sourceId: "a",
        postedAt: "2026-08-02T00:00:00.000Z",
        amountUsd: 40,
      }),
      tx({
        sourceId: "b",
        postedAt: "2026-08-03T00:00:00.000Z",
        amountUsd: 25,
      }),
    ]);
    expect(balances).toHaveLength(2);
    const a = balances.find((b) => b.sourceId === "a");
    const b = balances.find((row) => row.sourceId === "b");
    expect(a?.netFlowUsd).toBe(60);
    expect(a?.settledCreditsUsd).toBe(100);
    expect(a?.settledDebitsUsd).toBe(40);
    expect(a?.latestActivityAt).toBe("2026-08-02T00:00:00.000Z");
    expect(b?.netFlowUsd).toBe(-25);
  });

  it("excludes pending rows from settled figures and reports them separately", () => {
    const balances = computeSourceBalances(
      [source({ id: "a" })],
      [
        tx({
          sourceId: "a",
          postedAt: "2026-08-01T00:00:00.000Z",
          amountUsd: 10,
        }),
        tx({
          sourceId: "a",
          postedAt: "2026-08-02T00:00:00.000Z",
          amountUsd: 55.5,
          metadata: { pending: true },
        }),
      ],
    );
    expect(balances[0].netFlowUsd).toBe(-10);
    expect(balances[0].settledTransactionCount).toBe(1);
    expect(balances[0].pendingCount).toBe(1);
    expect(balances[0].pendingDebitsUsd).toBe(55.5);
  });

  it("surfaces every observed currency instead of silently merging", () => {
    const balances = computeSourceBalances(
      [source({ id: "a" })],
      [
        tx({
          sourceId: "a",
          postedAt: "2026-08-01T00:00:00.000Z",
          amountUsd: 10,
        }),
        tx({
          sourceId: "a",
          postedAt: "2026-08-02T00:00:00.000Z",
          amountUsd: 12,
          currency: "EUR",
        }),
      ],
    );
    expect(balances[0].currencies).toEqual(["EUR", "USD"]);
  });

  it("returns a zeroed record with null freshness for a source with no rows", () => {
    const balances = computeSourceBalances([source({ id: "empty" })], []);
    expect(balances[0].settledTransactionCount).toBe(0);
    expect(balances[0].latestActivityAt).toBeNull();
    expect(balances[0].currencies).toEqual([]);
  });
});

describe("computeBudgetStatus", () => {
  const inWindow = "2026-08-15T00:00:00.000Z";
  it("classifies under, near-limit, and over budget", () => {
    const rows = [
      tx({ sourceId: "a", postedAt: inWindow, amountUsd: 45 }),
      tx({ sourceId: "a", postedAt: inWindow, amountUsd: 46 }),
    ];
    const under = computeBudgetStatus({
      transactions: rows,
      budgetUsd: 200,
      windowDays: 30,
      now: NOW,
    });
    expect(under.status).toBe("under_budget");
    expect(under.spentUsd).toBe(91);
    expect(under.remainingUsd).toBe(109);

    const near = computeBudgetStatus({
      transactions: rows,
      budgetUsd: 100,
      windowDays: 30,
      now: NOW,
    });
    expect(near.status).toBe("near_limit");

    const over = computeBudgetStatus({
      transactions: rows,
      budgetUsd: 90,
      windowDays: 30,
      now: NOW,
    });
    expect(over.status).toBe("over_budget");
    expect(over.remainingUsd).toBe(-1);
  });

  it("ignores credits, pending rows, and rows outside the window", () => {
    const status = computeBudgetStatus({
      transactions: [
        tx({ sourceId: "a", postedAt: inWindow, amountUsd: 30 }),
        tx({
          sourceId: "a",
          postedAt: inWindow,
          amountUsd: 500,
          direction: "credit",
        }),
        tx({
          sourceId: "a",
          postedAt: inWindow,
          amountUsd: 99,
          metadata: { pending: true },
        }),
        tx({
          sourceId: "a",
          postedAt: "2026-01-01T00:00:00.000Z",
          amountUsd: 999,
        }),
      ],
      budgetUsd: 100,
      windowDays: 30,
      now: NOW,
    });
    expect(status.spentUsd).toBe(30);
    expect(status.settledTransactionCount).toBe(1);
    expect(status.pendingExcludedCount).toBe(1);
    expect(status.status).toBe("under_budget");
  });

  it("handles an empty ledger as zero spend, not an error", () => {
    const status = computeBudgetStatus({
      transactions: [],
      budgetUsd: 50,
      windowDays: 7,
      now: NOW,
    });
    expect(status.spentUsd).toBe(0);
    expect(status.utilization).toBe(0);
    expect(status.status).toBe("under_budget");
  });
});

describe("detectAnomalies", () => {
  it("flags same-source same-amount charges within 3 days as possible duplicates", () => {
    const anomalies = detectAnomalies([
      tx({
        sourceId: "a",
        postedAt: "2026-08-01T00:00:00.000Z",
        amountUsd: 14.99,
        merchantNormalized: "netflix",
      }),
      tx({
        sourceId: "a",
        postedAt: "2026-08-02T12:00:00.000Z",
        amountUsd: 14.99,
        merchantNormalized: "netflix",
      }),
    ]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].kind).toBe("possible_duplicate_charge");
    expect(anomalies[0].transactionIds).toHaveLength(2);
  });

  it("groups adversarial merchant strings via the normalized name", () => {
    const anomalies = detectAnomalies([
      tx({
        sourceId: "a",
        postedAt: "2026-08-01T00:00:00.000Z",
        amountUsd: 9.99,
        merchantRaw: "NETFLlX.COM*8873",
        merchantNormalized: "netflix",
      }),
      tx({
        sourceId: "a",
        postedAt: "2026-08-01T06:00:00.000Z",
        amountUsd: 9.99,
        merchantRaw: "Netflix",
        merchantNormalized: "netflix",
      }),
    ]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].merchantNormalized).toBe("netflix");
  });

  it("does not flag duplicates across different sources, amounts, or beyond 3 days", () => {
    const anomalies = detectAnomalies([
      tx({
        sourceId: "a",
        postedAt: "2026-08-01T00:00:00.000Z",
        amountUsd: 14.99,
      }),
      tx({
        sourceId: "b",
        postedAt: "2026-08-01T00:00:00.000Z",
        amountUsd: 14.99,
      }),
      tx({
        sourceId: "a",
        postedAt: "2026-08-10T00:00:00.000Z",
        amountUsd: 14.99,
      }),
      tx({
        sourceId: "a",
        postedAt: "2026-08-10T01:00:00.000Z",
        amountUsd: 15.99,
      }),
    ]);
    expect(anomalies).toEqual([]);
  });

  it("never raises anomalies from pending rows (pending+settled pairs are normal)", () => {
    const anomalies = detectAnomalies([
      tx({
        sourceId: "a",
        postedAt: "2026-08-01T00:00:00.000Z",
        amountUsd: 42,
        metadata: { pending: true },
      }),
      tx({
        sourceId: "a",
        postedAt: "2026-08-02T00:00:00.000Z",
        amountUsd: 42,
      }),
    ]);
    expect(anomalies).toEqual([]);
  });

  it("flags an amount spike only with enough history and a material delta", () => {
    const history = [
      tx({
        sourceId: "a",
        postedAt: "2026-05-01T00:00:00.000Z",
        amountUsd: 12,
      }),
      tx({
        sourceId: "a",
        postedAt: "2026-06-01T00:00:00.000Z",
        amountUsd: 11,
      }),
      tx({
        sourceId: "a",
        postedAt: "2026-07-01T00:00:00.000Z",
        amountUsd: 13,
      }),
    ];
    const spike = detectAnomalies([
      ...history,
      tx({
        sourceId: "a",
        postedAt: "2026-08-01T00:00:00.000Z",
        amountUsd: 95,
      }),
    ]);
    expect(spike).toHaveLength(1);
    expect(spike[0].kind).toBe("amount_spike");
    expect(spike[0].amountUsd).toBe(95);

    // Two prior charges is not enough history to call anything a spike.
    const thinHistory = detectAnomalies([
      ...history.slice(0, 2),
      tx({
        sourceId: "a",
        postedAt: "2026-08-01T00:00:00.000Z",
        amountUsd: 95,
      }),
    ]);
    expect(thinHistory).toEqual([]);
  });

  it("returns an empty list for an empty ledger", () => {
    expect(detectAnomalies([])).toEqual([]);
  });
});

describe("normalizeSubscriptions", () => {
  function charge(
    overrides: Partial<LifeOpsRecurringCharge>,
  ): LifeOpsRecurringCharge {
    return {
      merchantNormalized: "netflix",
      merchantDisplay: "Netflix",
      cadence: "monthly",
      averageAmountUsd: 14.99,
      lastAmountUsd: 14.99,
      annualizedCostUsd: 179.88,
      occurrenceCount: 6,
      firstSeenAt: "2026-02-01T00:00:00.000Z",
      latestSeenAt: "2026-08-01T00:00:00.000Z",
      nextExpectedAt: "2026-09-01T00:00:00.000Z",
      sourceIds: ["a"],
      sampleTransactionIds: ["tx-1"],
      confidence: 0.9,
      category: "entertainment",
      ...overrides,
    };
  }

  it("keeps regular-cadence confident charges and drops irregular/low-confidence ones", () => {
    const subs = normalizeSubscriptions([
      charge({}),
      charge({ merchantNormalized: "gym", cadence: "irregular" }),
      charge({ merchantNormalized: "shady", confidence: 0.2 }),
    ]);
    expect(subs).toHaveLength(1);
    expect(subs[0].merchantNormalized).toBe("netflix");
  });

  it("sorts by annualized cost descending and handles the empty case", () => {
    const subs = normalizeSubscriptions([
      charge({ merchantNormalized: "cheap", annualizedCostUsd: 60 }),
      charge({ merchantNormalized: "pricey", annualizedCostUsd: 600 }),
    ]);
    expect(subs.map((s) => s.merchantNormalized)).toEqual(["pricey", "cheap"]);
    expect(normalizeSubscriptions([])).toEqual([]);
  });
});

describe("buildCapabilityMeta / buildWriteReceipt / isPendingTransaction", () => {
  it("reports freshness from consumed rows and null for empty input", () => {
    const meta = buildCapabilityMeta({
      capability: "finance.balances",
      now: NOW,
      transactions: [
        tx({
          sourceId: "a",
          postedAt: "2026-08-01T00:00:00.000Z",
          amountUsd: 1,
        }),
        tx({
          sourceId: "a",
          postedAt: "2026-08-05T00:00:00.000Z",
          amountUsd: 2,
        }),
      ],
      sourceCount: 1,
      method: "derived_from_transactions",
      windowDays: 30,
      notes: ["derived"],
    });
    expect(meta.provider).toBe("plugin-finances");
    expect(meta.generatedAt).toBe(NOW.toISOString());
    expect(meta.freshness.latestDataAt).toBe("2026-08-05T00:00:00.000Z");
    expect(meta.freshness.transactionCount).toBe(2);
    expect(meta.calculation.windowDays).toBe(30);

    const empty = buildCapabilityMeta({
      capability: "finance.balances",
      now: NOW,
      transactions: [],
      sourceCount: 0,
      method: "derived_from_transactions",
    });
    expect(empty.freshness.latestDataAt).toBeNull();
    expect(empty.calculation.windowDays).toBeNull();
  });

  it("honors explicit freshness for aggregate-input capabilities", () => {
    const meta = buildCapabilityMeta({
      capability: "finance.subscriptions",
      now: NOW,
      transactions: [],
      latestDataAt: "2026-08-10T00:00:00.000Z",
      transactionCount: 12,
      sourceCount: 2,
      method: "derived_from_transactions",
    });
    expect(meta.freshness.latestDataAt).toBe("2026-08-10T00:00:00.000Z");
    expect(meta.freshness.transactionCount).toBe(12);
    expect(meta.freshness.sourceCount).toBe(2);

    const explicitlyEmpty = buildCapabilityMeta({
      capability: "finance.subscriptions",
      now: NOW,
      transactions: [],
      latestDataAt: null,
      transactionCount: 0,
      sourceCount: 0,
      method: "derived_from_transactions",
    });
    expect(explicitlyEmpty.freshness.latestDataAt).toBeNull();
  });

  it("counts distinct sources across consumed rows", () => {
    expect(countDistinctSources([])).toBe(0);
    expect(
      countDistinctSources([
        tx({
          sourceId: "a",
          postedAt: "2026-08-01T00:00:00.000Z",
          amountUsd: 1,
        }),
        tx({
          sourceId: "a",
          postedAt: "2026-08-02T00:00:00.000Z",
          amountUsd: 2,
        }),
        tx({
          sourceId: "b",
          postedAt: "2026-08-03T00:00:00.000Z",
          amountUsd: 3,
        }),
      ]),
    ).toBe(2);
  });

  it("issues unique receipts describing the write without payload data", () => {
    const first = buildWriteReceipt({
      capability: "finance.import_csv",
      operation: "import",
      entityType: "transactions",
      entityId: "source-1",
      now: NOW,
      counts: { inserted: 3, skipped: 1, errors: 0 },
    });
    const second = buildWriteReceipt({
      capability: "finance.add_source",
      operation: "create",
      entityType: "payment_source",
      entityId: "source-2",
      now: NOW,
    });
    expect(first.receiptId).not.toBe(second.receiptId);
    expect(first.outcome).toBe("applied");
    expect(first.counts).toEqual({ inserted: 3, skipped: 1, errors: 0 });
    expect(second.counts).toBeNull();
    expect(first.occurredAt).toBe(NOW.toISOString());
    expect(Object.keys(first).sort()).toEqual([
      "capability",
      "counts",
      "entityId",
      "entityType",
      "occurredAt",
      "operation",
      "outcome",
      "receiptId",
    ]);
  });

  it("only treats an explicit boolean pending flag as pending", () => {
    expect(
      isPendingTransaction(
        tx({
          sourceId: "a",
          postedAt: "2026-08-01T00:00:00.000Z",
          amountUsd: 1,
          metadata: { pending: true },
        }),
      ),
    ).toBe(true);
    expect(
      isPendingTransaction(
        tx({
          sourceId: "a",
          postedAt: "2026-08-01T00:00:00.000Z",
          amountUsd: 1,
          metadata: { pending: "yes" },
        }),
      ),
    ).toBe(false);
  });
});
