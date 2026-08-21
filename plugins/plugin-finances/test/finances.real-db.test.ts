/**
 * Real-DB integration tests for the finances back-end.
 *
 * Unlike `plugin.test.ts` / `services/migration.test.ts` (which mock
 * `runtime.adapter.db.execute`), this suite boots a REAL PGLite-backed
 * AgentRuntime via {@link createRealTestRuntime}, registers `financesPlugin`
 * so the SQL plugin materializes the `app_finances` tables from the plugin
 * `schema` field, then exercises `FinancesService` + `FinancesRepository`
 * against that live database. Every assertion is an insert-then-read-back
 * round-trip, so nothing about the SQL construction or row parsing is faked.
 *
 * Hermetic: no network, no credentials. The Plaid / PayPal bridges (the only
 * methods needing Eliza Cloud) are deliberately out of scope.
 */

import type { AgentRuntime, HandlerOptions, Memory } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app-core/test/helpers/real-runtime.ts";
import { runPaymentsHandler } from "../src/actions/finances.ts";
import { FinancesRepository } from "../src/db/finances-repository.ts";
import { FinancesService } from "../src/finances-service.ts";
import financesPlugin from "../src/plugin.ts";

describe("FinancesService + FinancesRepository — real PGLite", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let service: FinancesService;
  let repository: FinancesRepository;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "finances-real-db-tests",
      // Registering the plugin makes runtime.initialize() run the SQL plugin's
      // migration for the `app_finances` schema (the plugin `schema` field).
      plugins: [financesPlugin],
    });
    runtime = testResult.runtime;
    service = new FinancesService(runtime);
    repository = new FinancesRepository(runtime);
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  it("creates a payment source and reads it back via the repository", async () => {
    const created = await service.addPaymentSource({
      kind: "manual",
      label: "Checking",
      institution: "Test Bank",
      accountMask: "1234",
    });
    expect(created.id).toBeTruthy();
    expect(created.status).toBe("active");

    // Round-trip: the row is really in the DB.
    const fetched = await repository.getPaymentSource(
      runtime.agentId,
      created.id,
    );
    expect(fetched).not.toBeNull();
    expect(fetched?.label).toBe("Checking");
    expect(fetched?.institution).toBe("Test Bank");
    expect(fetched?.accountMask).toBe("1234");
    expect(fetched?.kind).toBe("manual");

    const list = await service.listPaymentSources();
    expect(list.find((s) => s.id === created.id)).toBeTruthy();
  });

  it("inserts transactions and lists / spending round-trips against the real DB", async () => {
    const source = await service.addPaymentSource({
      kind: "manual",
      label: "Spending account",
    });

    const now = Date.now();
    const iso = (offsetDays: number) =>
      new Date(now - offsetDays * 86_400_000).toISOString();

    const inserted = await Promise.all([
      repository.insertPaymentTransaction({
        id: "txn-coffee-1",
        agentId: runtime.agentId,
        sourceId: source.id,
        externalId: null,
        postedAt: iso(1),
        amountUsd: 4.5,
        direction: "debit",
        merchantRaw: "Blue Bottle Coffee",
        merchantNormalized: "blue bottle coffee",
        description: "Latte",
        category: "Food & Drink",
        currency: "USD",
        metadata: {},
        createdAt: new Date().toISOString(),
      }),
      repository.insertPaymentTransaction({
        id: "txn-rent-1",
        agentId: runtime.agentId,
        sourceId: source.id,
        externalId: null,
        postedAt: iso(2),
        amountUsd: 1500,
        direction: "debit",
        merchantRaw: "Landlord LLC",
        merchantNormalized: "landlord llc",
        description: "Rent",
        category: "Housing",
        currency: "USD",
        metadata: {},
        createdAt: new Date().toISOString(),
      }),
      repository.insertPaymentTransaction({
        id: "txn-paycheck-1",
        agentId: runtime.agentId,
        sourceId: source.id,
        externalId: null,
        postedAt: iso(3),
        amountUsd: 5000,
        direction: "credit",
        merchantRaw: "ACME Payroll",
        merchantNormalized: "acme payroll",
        description: "Salary",
        category: "Income",
        currency: "USD",
        metadata: {},
        createdAt: new Date().toISOString(),
      }),
    ]);
    expect(inserted).toEqual([true, true, true]);

    // ON CONFLICT DO NOTHING: re-inserting the same id is a no-op.
    const dup = await repository.insertPaymentTransaction({
      id: "txn-coffee-1",
      agentId: runtime.agentId,
      sourceId: source.id,
      externalId: null,
      postedAt: iso(1),
      amountUsd: 4.5,
      direction: "debit",
      merchantRaw: "Blue Bottle Coffee",
      merchantNormalized: "blue bottle coffee",
      description: "Latte",
      category: "Food & Drink",
      currency: "USD",
      metadata: {},
      createdAt: new Date().toISOString(),
    });
    expect(dup).toBe(false);

    // listTransactions reads the rows back, newest-first.
    const txns = await service.listTransactions({ sourceId: source.id });
    expect(txns.map((t) => t.id).sort()).toEqual([
      "txn-coffee-1",
      "txn-paycheck-1",
      "txn-rent-1",
    ]);
    const coffee = txns.find((t) => t.id === "txn-coffee-1");
    expect(coffee?.amountUsd).toBe(4.5);
    expect(coffee?.merchantNormalized).toBe("blue bottle coffee");

    // onlyDebits filter applied at the SQL layer.
    const debits = await service.listTransactions({
      sourceId: source.id,
      onlyDebits: true,
    });
    expect(debits.every((t) => t.direction === "debit")).toBe(true);
    expect(debits).toHaveLength(2);

    // Spending summary aggregates the real rows.
    const spending = await service.getSpendingSummary({
      sourceId: source.id,
      windowDays: 30,
    });
    expect(spending.totalSpendUsd).toBe(1504.5);
    expect(spending.totalIncomeUsd).toBe(5000);
    expect(spending.netUsd).toBe(3495.5);
    expect(spending.transactionCount).toBe(3);
    expect(
      spending.topCategories.find((c) => c.category === "Housing")?.totalUsd,
    ).toBe(1500);

    // countPaymentTransactionsForSource is a real COUNT(*).
    const count = await repository.countPaymentTransactionsForSource(
      runtime.agentId,
      source.id,
    );
    expect(count).toBe(3);
  });

  it("detects a recurring charge from real monthly transactions", async () => {
    const source = await service.addPaymentSource({
      kind: "manual",
      label: "Subscriptions",
    });
    // Three monthly $15.99 charges → a detectable monthly recurring charge.
    for (let monthsAgo = 0; monthsAgo < 3; monthsAgo += 1) {
      const postedAt = new Date(
        Date.now() - monthsAgo * 30 * 86_400_000,
      ).toISOString();
      const ok = await repository.insertPaymentTransaction({
        id: `txn-netflix-${monthsAgo}`,
        agentId: runtime.agentId,
        sourceId: source.id,
        externalId: null,
        postedAt,
        amountUsd: 15.99,
        direction: "debit",
        merchantRaw: "Netflix",
        merchantNormalized: "netflix",
        description: "Netflix monthly",
        category: "Entertainment",
        currency: "USD",
        metadata: {},
        createdAt: new Date().toISOString(),
      });
      expect(ok).toBe(true);
    }

    const recurring = await service.getRecurringCharges({
      sourceId: source.id,
    });
    const netflix = recurring.find((r) => r.merchantNormalized === "netflix");
    expect(netflix).toBeTruthy();
    expect(netflix?.occurrenceCount).toBeGreaterThanOrEqual(3);
    expect(netflix?.averageAmountUsd).toBeCloseTo(15.99, 2);
  });

  it("deletePaymentSource cascades transaction deletion in the real DB", async () => {
    const source = await service.addPaymentSource({
      kind: "manual",
      label: "Disposable",
    });
    await repository.insertPaymentTransaction({
      id: "txn-disposable-1",
      agentId: runtime.agentId,
      sourceId: source.id,
      externalId: null,
      postedAt: new Date().toISOString(),
      amountUsd: 9.99,
      direction: "debit",
      merchantRaw: "Throwaway",
      merchantNormalized: "throwaway",
      description: null,
      category: null,
      currency: "USD",
      metadata: {},
      createdAt: new Date().toISOString(),
    });
    expect(
      await repository.countPaymentTransactionsForSource(
        runtime.agentId,
        source.id,
      ),
    ).toBe(1);

    await service.deletePaymentSource(source.id);

    expect(
      await repository.getPaymentSource(runtime.agentId, source.id),
    ).toBeNull();
    expect(
      await repository.countPaymentTransactionsForSource(
        runtime.agentId,
        source.id,
      ),
    ).toBe(0);
  });

  it("upsertBillFromEmail is idempotent by source message id (real DB)", async () => {
    const first = await service.upsertBillFromEmail({
      sourceMessageId: "gmail-msg-1",
      merchant: "Electric Co",
      amountUsd: 87.42,
      currency: "USD",
      dueDate: "2026-07-01",
      confidence: 0.9,
    });
    expect(first.inserted).toBe(true);

    // Re-ingesting the same Gmail message id does not create a duplicate.
    const second = await service.upsertBillFromEmail({
      sourceMessageId: "gmail-msg-1",
      merchant: "Electric Co",
      amountUsd: 87.42,
      currency: "USD",
      dueDate: "2026-07-01",
      confidence: 0.9,
    });
    expect(second.inserted).toBe(false);
    expect(second.transactionId).toBe(first.transactionId);

    const bills = await service.getUpcomingBills();
    const electric = bills.find((b) => b.id === first.transactionId);
    expect(electric).toBeTruthy();
    expect(electric?.amountUsd).toBe(87.42);
    expect(electric?.dueDate).toBe("2026-07-01");
  });

  describe("normalized capability subactions via runPaymentsHandler (real DB)", () => {
    function actionMessage(): Memory {
      return {
        entityId: runtime.agentId,
        roomId: runtime.agentId,
        content: { text: "" },
      };
    }
    const run = (parameters: Record<string, unknown>) =>
      runPaymentsHandler(runtime, actionMessage(), undefined, {
        parameters,
      } as HandlerOptions);

    it("add_source and remove_source return internal-write receipts", async () => {
      const added = await run({
        subaction: "add_source",
        kind: "manual",
        label: "Receipted account",
      });
      expect(added.success).toBe(true);
      const addedData = added.data as {
        source: { id: string };
        receipt: {
          receiptId: string;
          capability: string;
          operation: string;
          entityId: string;
          outcome: string;
        };
      };
      expect(addedData.receipt.capability).toBe("finance.add_source");
      expect(addedData.receipt.operation).toBe("create");
      expect(addedData.receipt.entityId).toBe(addedData.source.id);
      expect(addedData.receipt.outcome).toBe("applied");

      const removed = await run({
        subaction: "remove_source",
        sourceId: addedData.source.id,
      });
      expect(removed.success).toBe(true);
      const removedData = removed.data as {
        receipt: { capability: string; operation: string; entityId: string };
      };
      expect(removedData.receipt.capability).toBe("finance.remove_source");
      expect(removedData.receipt.operation).toBe("delete");
      expect(removedData.receipt.entityId).toBe(addedData.source.id);
      expect(removedData.receipt.entityId).not.toBe(
        addedData.receipt.receiptId,
      );
    });

    it("import_csv issues a receipt only when rows were actually inserted", async () => {
      const source = await service.addPaymentSource({
        kind: "csv",
        label: "CSV receipt account",
      });
      const csvText =
        "Date,Amount,Merchant\n2026-08-01,-12.50,Coffee Shop\n2026-08-02,-30.00,Grocer\n";
      const first = await run({
        subaction: "import_csv",
        sourceId: source.id,
        csvText,
      });
      expect(first.success).toBe(true);
      const firstData = first.data as {
        result: { inserted: number; skipped: number };
        receipt?: { capability: string; counts: { inserted: number } | null };
      };
      expect(firstData.result.inserted).toBe(2);
      expect(firstData.receipt?.capability).toBe("finance.import_csv");
      expect(firstData.receipt?.counts?.inserted).toBe(2);

      // An all-duplicate replay succeeds but mutates nothing: no receipt.
      const replay = await run({
        subaction: "import_csv",
        sourceId: source.id,
        csvText,
      });
      expect(replay.success).toBe(true);
      const replayData = replay.data as {
        result: { inserted: number; skipped: number };
        receipt?: unknown;
      };
      expect(replayData.result.inserted).toBe(0);
      expect(replayData.result.skipped).toBe(2);
      expect(replayData.receipt).toBeUndefined();
    });

    it("balances derives per-source figures with freshness metadata", async () => {
      const source = await service.addPaymentSource({
        kind: "manual",
        label: "Balances account",
      });
      const postedAt = new Date(Date.now() - 86_400_000).toISOString();
      await repository.insertPaymentTransaction({
        id: "txn-balance-credit",
        agentId: runtime.agentId,
        sourceId: source.id,
        externalId: null,
        postedAt,
        amountUsd: 250,
        direction: "credit",
        merchantRaw: "ACME Payroll",
        merchantNormalized: "acme payroll",
        description: null,
        category: null,
        currency: "USD",
        metadata: {},
        createdAt: new Date().toISOString(),
      });
      await repository.insertPaymentTransaction({
        id: "txn-balance-pending",
        agentId: runtime.agentId,
        sourceId: source.id,
        externalId: null,
        postedAt,
        amountUsd: 40,
        direction: "debit",
        merchantRaw: "Pending Store",
        merchantNormalized: "pending store",
        description: null,
        category: null,
        currency: "USD",
        metadata: { pending: true },
        createdAt: new Date().toISOString(),
      });

      const result = await run({ subaction: "balances", sourceId: source.id });
      expect(result.success).toBe(true);
      const data = result.data as {
        balances: {
          sourceId: string;
          netFlowUsd: number;
          pendingCount: number;
          latestActivityAt: string | null;
        }[];
        meta: {
          capability: string;
          provider: string;
          freshness: { latestDataAt: string | null; transactionCount: number };
          calculation: { method: string };
        };
      };
      expect(data.balances).toHaveLength(1);
      expect(data.balances[0].netFlowUsd).toBe(250);
      expect(data.balances[0].pendingCount).toBe(1);
      expect(data.meta.capability).toBe("finance.balances");
      expect(data.meta.provider).toBe("plugin-finances");
      expect(data.meta.calculation.method).toBe("derived_from_transactions");
      expect(data.meta.freshness.latestDataAt).toBe(postedAt);
    });

    it("budget_status rejects a missing budget and evaluates a supplied one", async () => {
      const missing = await run({ subaction: "budget_status" });
      expect(missing.success).toBe(false);
      expect((missing.data as { error: string }).error).toBe(
        "MISSING_BUDGET_AMOUNT",
      );

      const source = await service.addPaymentSource({
        kind: "manual",
        label: "Budget account",
      });
      await repository.insertPaymentTransaction({
        id: "txn-budget-1",
        agentId: runtime.agentId,
        sourceId: source.id,
        externalId: null,
        postedAt: new Date(Date.now() - 3_600_000).toISOString(),
        amountUsd: 120,
        direction: "debit",
        merchantRaw: "Grocer",
        merchantNormalized: "grocer",
        description: null,
        category: null,
        currency: "USD",
        metadata: {},
        createdAt: new Date().toISOString(),
      });
      const result = await run({
        subaction: "budget_status",
        sourceId: source.id,
        budgetUsd: 100,
        windowDays: 30,
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        budget: { spentUsd: number; status: string; remainingUsd: number };
        meta: { calculation: { method: string; windowDays: number | null } };
      };
      expect(data.budget.spentUsd).toBe(120);
      expect(data.budget.status).toBe("over_budget");
      expect(data.budget.remainingUsd).toBe(-20);
      expect(data.meta.calculation.method).toBe("user_supplied_input");
      expect(data.meta.calculation.windowDays).toBe(30);
    });

    it("anomalies flags a real duplicate charge and subscriptions handles empty data", async () => {
      const source = await service.addPaymentSource({
        kind: "manual",
        label: "Anomaly account",
      });
      const base = Date.now() - 2 * 86_400_000;
      for (const [index, offsetHours] of [0, 12].entries()) {
        await repository.insertPaymentTransaction({
          id: `txn-dupe-${index}`,
          agentId: runtime.agentId,
          sourceId: source.id,
          externalId: null,
          postedAt: new Date(base + offsetHours * 3_600_000).toISOString(),
          amountUsd: 14.99,
          direction: "debit",
          merchantRaw: index === 0 ? "NETFLlX.COM*8873" : "Netflix",
          merchantNormalized: "netflix",
          description: null,
          category: null,
          currency: "USD",
          metadata: {},
          createdAt: new Date().toISOString(),
        });
      }
      const result = await run({ subaction: "anomalies", sourceId: source.id });
      expect(result.success).toBe(true);
      const data = result.data as {
        anomalies: { kind: string; transactionIds: string[] }[];
        meta: { capability: string };
      };
      expect(data.anomalies).toHaveLength(1);
      expect(data.anomalies[0].kind).toBe("possible_duplicate_charge");
      expect(data.anomalies[0].transactionIds.sort()).toEqual([
        "txn-dupe-0",
        "txn-dupe-1",
      ]);
      expect(data.meta.capability).toBe("finance.anomalies");

      const subs = await run({
        subaction: "subscriptions",
        sourceId: source.id,
      });
      expect(subs.success).toBe(true);
      const subsData = subs.data as {
        subscriptions: unknown[];
        meta: { capability: string };
      };
      // Two occurrences 12 hours apart are not a regular-cadence subscription.
      expect(subsData.subscriptions).toEqual([]);
      expect(subsData.meta.capability).toBe("finance.subscriptions");
    });
  });
});
