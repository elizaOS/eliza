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

import type { AgentRuntime } from "@elizaos/core";
import { PlaidManagedClient } from "@elizaos/plugin-elizacloud/cloud/managed-payment-clients";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app-core/test/helpers/real-runtime.ts";
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

  it("persists only an opaque Plaid connection and revokes it before deletion", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    let syncPage = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        requests.push({ url, body: String(init?.body ?? "") });
        if (url.endsWith("/exchange")) {
          return Response.json({
            connectionId: "11111111-1111-4111-8111-111111111111",
            environment: "sandbox",
            institution: {
              institutionId: "ins-1",
              institutionName: "Test Bank",
              primaryAccountMask: "1234",
              accounts: [],
            },
          });
        }
        if (url.endsWith("/sync")) {
          syncPage += 1;
          return Response.json({
            added: [],
            modified: [],
            removed: [],
            nextCursor: `cursor-${syncPage}`,
            hasMore: syncPage === 1,
          });
        }
        if (url.endsWith("/revoke")) {
          return Response.json({ revoked: true });
        }
        return Response.json({ error: "unexpected route" }, { status: 500 });
      });

    try {
      service.plaidManagedClientCache = new PlaidManagedClient(() => ({
        configured: true,
        apiKey: "eliza_test",
        apiBaseUrl: "https://cloud.example/api",
        siteUrl: "https://cloud.example",
      }));
      const source = await service.completePlaidLink({
        publicToken: "public-token",
      });
      const stored = await repository.getPaymentSource(
        runtime.agentId,
        source.id,
      );
      expect(stored?.metadata.plaid).toEqual(
        expect.objectContaining({
          connectionId: "11111111-1111-4111-8111-111111111111",
          environment: "sandbox",
        }),
      );
      expect(JSON.stringify(stored)).not.toContain("public-token");
      expect(JSON.stringify(stored)).not.toContain("accessToken");

      await expect(
        service.syncPlaidTransactions({ sourceId: source.id }),
      ).resolves.toMatchObject({ nextCursor: "cursor-2" });
      expect(
        requests.filter((request) => request.url.endsWith("/sync")),
      ).toHaveLength(2);
      await expect(service.deletePaymentSource(source.id)).resolves.toEqual({
        ok: true,
      });
      await expect(
        repository.getPaymentSource(runtime.agentId, source.id),
      ).resolves.toBeNull();

      const bodies = requests.map((request) => request.body).join("\n");
      expect(bodies).not.toContain("accessToken");
      expect(requests.at(-1)).toMatchObject({
        url: "https://cloud.example/api/v1/eliza/plaid/revoke",
        body: JSON.stringify({
          connectionId: "11111111-1111-4111-8111-111111111111",
        }),
      });
    } finally {
      fetchSpy.mockRestore();
      service.plaidManagedClientCache = null;
    }
  });

  it("revokes the Cloud connection when local source persistence fails", async () => {
    const requestedRoutes: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        requestedRoutes.push(url);
        if (url.endsWith("/exchange")) {
          return Response.json({
            connectionId: "22222222-2222-4222-8222-222222222222",
            environment: "sandbox",
            institution: {
              institutionId: "ins-2",
              institutionName: "Failure Bank",
              primaryAccountMask: null,
              accounts: [],
            },
          });
        }
        if (url.endsWith("/revoke")) {
          return Response.json({ revoked: true });
        }
        return Response.json({ error: "unexpected route" }, { status: 500 });
      });
    const persistSpy = vi
      .spyOn(service.repository, "upsertPaymentSource")
      .mockRejectedValueOnce(new Error("local persistence unavailable"));

    try {
      service.plaidManagedClientCache = new PlaidManagedClient(() => ({
        configured: true,
        apiKey: "eliza_test",
        apiBaseUrl: "https://cloud.example/api",
        siteUrl: "https://cloud.example",
      }));
      await expect(
        service.completePlaidLink({ publicToken: "public-token" }),
      ).rejects.toThrow("local persistence unavailable");
      expect(requestedRoutes).toEqual([
        "https://cloud.example/api/v1/eliza/plaid/exchange",
        "https://cloud.example/api/v1/eliza/plaid/revoke",
      ]);
    } finally {
      persistSpy.mockRestore();
      fetchSpy.mockRestore();
      service.plaidManagedClientCache = null;
    }
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
});
