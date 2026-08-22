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
 * Hermetic: no network or credentials. Plaid protocol responses are supplied
 * at the fetch boundary while storage, transactions, rollback, and migration
 * behavior execute against the real database.
 */

import type { AgentRuntime, HandlerOptions, Memory } from "@elizaos/core";
import {
  PlaidManagedClient,
  type PlaidTransactionDto,
} from "@elizaos/plugin-elizacloud/cloud/managed-payment-clients";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app-core/test/helpers/real-runtime.ts";
import { runPaymentsHandler } from "../src/actions/finances.ts";
import { FinancesRepository } from "../src/db/finances-repository.ts";
import { executeRawSql } from "../src/db/sql.ts";
import { FinancesService } from "../src/finances-service.ts";
import financesPlugin from "../src/plugin.ts";
import {
  FinancesMigrationService,
  scrubLegacyPlaidCredentials,
} from "../src/services/migration.ts";

function plaidTransaction(
  transactionId: string,
  overrides: Partial<PlaidTransactionDto> = {},
): PlaidTransactionDto {
  return {
    transaction_id: transactionId,
    account_id: "plaid-account-1",
    amount: 12.34,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    date: "2026-08-15",
    authorized_date: null,
    name: `Plaid transaction ${transactionId}`,
    merchant_name: "Adversarial Merchant",
    pending: false,
    category: ["Shops"],
    personal_finance_category: null,
    ...overrides,
  };
}

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

  it("rejects generic Plaid metadata before it can persist a local secret", async () => {
    await expect(
      service.addPaymentSource({
        kind: "plaid",
        label: "Forbidden local Plaid source",
        metadata: { plaid: { accessToken: "access-secret-sentinel" } },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      JSON.stringify(await repository.listPaymentSources(runtime.agentId)),
    ).not.toContain("access-secret-sentinel");
  });

  it("startup credential sweep scrubs dormant Plaid tokens in the real database", async () => {
    const secret = "access-dormant-startup-sentinel";
    const now = new Date().toISOString();
    const sourceId = crypto.randomUUID();
    await repository.upsertPaymentSource({
      id: sourceId,
      agentId: runtime.agentId,
      kind: "plaid",
      label: "Dormant Plaid source",
      institution: null,
      accountMask: null,
      status: "active",
      lastSyncedAt: null,
      transactionCount: 0,
      metadata: { plaid: { accessToken: secret, cursor: "old" } },
      createdAt: now,
      updatedAt: now,
    });
    await executeRawSql(runtime, "CREATE SCHEMA IF NOT EXISTS app_lifeops");
    await executeRawSql(
      runtime,
      `CREATE TABLE IF NOT EXISTS app_lifeops.life_payment_sources
       (LIKE app_finances.life_payment_sources INCLUDING ALL)`,
    );
    await executeRawSql(
      runtime,
      `INSERT INTO app_lifeops.life_payment_sources
       SELECT * FROM app_finances.life_payment_sources WHERE id = '${sourceId}'`,
    );
    await scrubLegacyPlaidCredentials((statement) =>
      executeRawSql(runtime, statement),
    );
    const stored = await repository.getPaymentSource(runtime.agentId, sourceId);
    expect(stored).toMatchObject({
      status: "needs_attention",
      metadata: {
        plaid: { cursor: "old", migrationStatus: "relink_required" },
      },
    });
    expect(JSON.stringify(stored)).not.toContain(secret);
    const retainedRows = await executeRawSql(
      runtime,
      `SELECT status, metadata_json FROM app_lifeops.life_payment_sources
       WHERE id = '${sourceId}'`,
    );
    expect(retainedRows[0]?.status).toBe("needs_attention");
    expect(String(retainedRows[0]?.metadata_json)).toContain("relink_required");
    expect(JSON.stringify(retainedRows)).not.toContain(secret);
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
        apiBaseUrl: "https://cloud.example/api/v1",
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
        apiBaseUrl: "https://cloud.example/api/v1",
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

  it("drains Plaid pagination beyond the former 20-page ceiling", async () => {
    let page = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/exchange")) {
          return Response.json({
            connectionId: "33333333-3333-4333-8333-333333333333",
            environment: "sandbox",
            institution: {
              institutionId: "ins-3",
              institutionName: "Pagination Bank",
              primaryAccountMask: null,
              accounts: [],
            },
          });
        }
        if (url.endsWith("/sync")) {
          page += 1;
          return Response.json({
            added: [plaidTransaction(`page-${page}`)],
            modified: [],
            removed: [],
            nextCursor: `cursor-${page}`,
            hasMore: page < 25,
          });
        }
        return Response.json({ error: "unexpected route" }, { status: 500 });
      });

    try {
      service.plaidManagedClientCache = new PlaidManagedClient(() => ({
        configured: true,
        apiKey: "eliza_test",
        apiBaseUrl: "https://cloud.example/api/v1",
        siteUrl: "https://cloud.example",
      }));
      const source = await service.completePlaidLink({
        publicToken: "public-token",
      });

      await expect(
        service.syncPlaidTransactions({ sourceId: source.id }),
      ).resolves.toEqual({
        inserted: 25,
        skipped: 0,
        nextCursor: "cursor-25",
      });

      const stored = await repository.getPaymentSource(
        runtime.agentId,
        source.id,
      );
      expect(stored?.metadata.plaid).toMatchObject({ cursor: "cursor-25" });
      await expect(
        repository.listPaymentTransactions(runtime.agentId, {
          sourceId: source.id,
        }),
      ).resolves.toHaveLength(25);
    } finally {
      fetchSpy.mockRestore();
      service.plaidManagedClientCache = null;
    }
  });

  it("rejects a Plaid cursor cycle without advancing state or persisting a partial delta", async () => {
    let page = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/exchange")) {
          return Response.json({
            connectionId: "33333333-3333-4333-8333-333333333334",
            environment: "sandbox",
            institution: {
              institutionId: "ins-cycle",
              institutionName: "Cycle Bank",
              primaryAccountMask: null,
              accounts: [],
            },
          });
        }
        if (url.endsWith("/sync")) {
          page += 1;
          return Response.json({
            added: [plaidTransaction(`cycle-page-${page}`)],
            modified: [],
            removed: [],
            nextCursor: page === 1 ? "cursor-a" : "",
            hasMore: true,
          });
        }
        return Response.json({ error: "unexpected route" }, { status: 500 });
      });

    try {
      service.plaidManagedClientCache = new PlaidManagedClient(() => ({
        configured: true,
        apiKey: "eliza_test",
        apiBaseUrl: "https://cloud.example/api/v1",
        siteUrl: "https://cloud.example",
      }));
      const source = await service.completePlaidLink({
        publicToken: "public-token",
      });

      await expect(
        service.syncPlaidTransactions({ sourceId: source.id }),
      ).rejects.toThrow("Plaid sync returned a repeated pagination cursor");
      expect(page).toBe(2);

      const stored = await repository.getPaymentSource(
        runtime.agentId,
        source.id,
      );
      expect(stored?.metadata.plaid).toMatchObject({ cursor: "" });
      await expect(
        repository.listPaymentTransactions(runtime.agentId, {
          sourceId: source.id,
        }),
      ).resolves.toEqual([]);
    } finally {
      fetchSpy.mockRestore();
      service.plaidManagedClientCache = null;
    }
  });

  it("scrubs dormant legacy Plaid secrets during startup migration without API access", async () => {
    const secret = "access-sandbox-adversarial-do-not-retain";
    const now = new Date().toISOString();
    const sourceId = crypto.randomUUID();
    await repository.upsertPaymentSource({
      id: sourceId,
      agentId: runtime.agentId,
      kind: "plaid",
      label: "Legacy Plaid source",
      institution: "Legacy Bank",
      accountMask: "9999",
      status: "active",
      lastSyncedAt: null,
      transactionCount: 0,
      metadata: {
        unrelated: "preserved",
        plaid: {
          accessToken: secret,
          cursor: "legacy-cursor",
          institutionId: "legacy-institution",
        },
      },
      createdAt: now,
      updatedAt: now,
    });

    await FinancesMigrationService.start(runtime);

    const persisted = await repository.getPaymentSource(
      runtime.agentId,
      sourceId,
    );
    expect(persisted?.status).toBe("needs_attention");
    expect(persisted?.metadata.plaid).toEqual({
      cursor: "legacy-cursor",
      institutionId: "legacy-institution",
      migrationStatus: "relink_required",
    });
    expect(persisted?.metadata.unrelated).toBe("preserved");
    expect(JSON.stringify(persisted)).not.toContain(secret);
    await expect(
      service.syncPlaidTransactions({ sourceId }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("keeps distinct Plaid ids even when every legacy uniqueness field matches", async () => {
    const now = new Date().toISOString();
    const sourceId = crypto.randomUUID();
    const source = {
      id: sourceId,
      agentId: runtime.agentId,
      kind: "plaid" as const,
      label: "Provider identity bank",
      institution: "Provider identity bank",
      accountMask: null,
      status: "active" as const,
      lastSyncedAt: null,
      transactionCount: 0,
      metadata: { plaid: { connectionId: crypto.randomUUID(), cursor: "" } },
      createdAt: now,
      updatedAt: now,
    };
    await repository.upsertPaymentSource(source);
    const buildRecord = (externalId: string) => ({
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      sourceId,
      externalId,
      postedAt: "2026-08-19T00:00:00.000Z",
      amountUsd: 12.34,
      direction: "debit" as const,
      merchantRaw: "Same Merchant",
      merchantNormalized: "same merchant",
      description: null,
      category: null,
      currency: "USD",
      metadata: {},
      createdAt: now,
    });

    await expect(
      repository.applyPlaidSync({
        expectedCursor: "",
        source: {
          ...source,
          metadata: {
            plaid: { connectionId: crypto.randomUUID(), cursor: "cursor-2" },
          },
        },
        added: [
          buildRecord("plaid-distinct-a"),
          buildRecord("plaid-distinct-b"),
        ],
        modified: [],
        removedExternalIds: [],
      }),
    ).resolves.toMatchObject({ inserted: 2, transactionCount: 2 });

    const transactions = await repository.listPaymentTransactions(
      runtime.agentId,
      { sourceId },
    );
    expect(
      transactions.map((transaction) => transaction.externalId).sort(),
    ).toEqual(["plaid-distinct-a", "plaid-distinct-b"]);
  });

  it("preserves typed relink errors and persists a visible needs-attention state", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/exchange")) {
          return Response.json({
            connectionId: "55555555-5555-4555-8555-555555555555",
            environment: "sandbox",
            institution: {
              institutionId: "ins-5",
              institutionName: "Relink Bank",
              primaryAccountMask: null,
              accounts: [],
            },
          });
        }
        if (url.endsWith("/sync")) {
          return Response.json(
            {
              error: "Plaid login is required",
              code: "ITEM_LOGIN_REQUIRED",
            },
            { status: 400 },
          );
        }
        return Response.json({ error: "unexpected route" }, { status: 500 });
      });

    try {
      service.plaidManagedClientCache = new PlaidManagedClient(() => ({
        configured: true,
        apiKey: "eliza_test",
        apiBaseUrl: "https://cloud.example/api/v1",
        siteUrl: "https://cloud.example",
      }));
      const source = await service.completePlaidLink({
        publicToken: "public-token",
      });
      await expect(
        service.syncPlaidTransactions({ sourceId: source.id }),
      ).rejects.toMatchObject({
        status: 400,
        code: "ITEM_LOGIN_REQUIRED",
      });
      const stored = await repository.getPaymentSource(
        runtime.agentId,
        source.id,
      );
      expect(stored?.status).toBe("needs_attention");
    } finally {
      fetchSpy.mockRestore();
      service.plaidManagedClientCache = null;
    }
  });

  it("restarts mutation-during-pagination and atomically applies added, modified, and removed rows", async () => {
    let syncRequest = 0;
    const requestedCursors: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/exchange")) {
          return Response.json({
            connectionId: "44444444-4444-4444-8444-444444444444",
            environment: "sandbox",
            institution: {
              institutionId: "ins-4",
              institutionName: "Mutation Bank",
              primaryAccountMask: null,
              accounts: [],
            },
          });
        }
        if (url.endsWith("/sync")) {
          syncRequest += 1;
          const body = JSON.parse(String(init?.body)) as { cursor: string };
          requestedCursors.push(body.cursor);
          if (syncRequest === 1) {
            return Response.json({
              added: [plaidTransaction("discarded-first-attempt")],
              modified: [],
              removed: [],
              nextCursor: "unstable-page-1",
              hasMore: true,
            });
          }
          if (syncRequest === 2) {
            return Response.json(
              {
                error: "Plaid pagination mutated",
                code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
              },
              { status: 400 },
            );
          }
          return Response.json({
            added: [plaidTransaction("new-transaction")],
            modified: [
              plaidTransaction("modify-transaction", {
                amount: 98.76,
                merchant_name: "Updated Merchant",
              }),
            ],
            removed: [{ transaction_id: "remove-transaction" }],
            nextCursor: "stable-cursor",
            hasMore: false,
          });
        }
        return Response.json({ error: "unexpected route" }, { status: 500 });
      });

    try {
      service.plaidManagedClientCache = new PlaidManagedClient(() => ({
        configured: true,
        apiKey: "eliza_test",
        apiBaseUrl: "https://cloud.example/api/v1",
        siteUrl: "https://cloud.example",
      }));
      const source = await service.completePlaidLink({
        publicToken: "public-token",
      });
      await service.upsertPlaidTransaction({
        sourceId: source.id,
        transaction: plaidTransaction("modify-transaction", { amount: 1 }),
      });
      await service.upsertPlaidTransaction({
        sourceId: source.id,
        transaction: plaidTransaction("remove-transaction"),
      });

      await expect(
        service.syncPlaidTransactions({ sourceId: source.id }),
      ).resolves.toEqual({
        inserted: 1,
        skipped: 0,
        nextCursor: "stable-cursor",
      });
      expect(requestedCursors).toEqual(["", "unstable-page-1", ""]);

      const transactions = await repository.listPaymentTransactions(
        runtime.agentId,
        { sourceId: source.id },
      );
      expect(
        transactions.map((transaction) => transaction.externalId).sort(),
      ).toEqual(["modify-transaction", "new-transaction"]);
      expect(
        transactions.find(
          (transaction) => transaction.externalId === "modify-transaction",
        ),
      ).toMatchObject({ amountUsd: 98.76, merchantRaw: "Updated Merchant" });
      expect(JSON.stringify(transactions)).not.toContain(
        "discarded-first-attempt",
      );
      const stored = await repository.getPaymentSource(
        runtime.agentId,
        source.id,
      );
      expect(stored?.metadata.plaid).toMatchObject({ cursor: "stable-cursor" });
      expect(stored?.transactionCount).toBe(2);
    } finally {
      fetchSpy.mockRestore();
      service.plaidManagedClientCache = null;
    }
  });

  it("serializes concurrent cursor windows and replays the stale caller", async () => {
    let releaseFirst: ((response: Response) => void) | undefined;
    let syncRequest = 0;
    const requestedCursors: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/exchange")) {
          return Response.json({
            connectionId: "66666666-6666-4666-8666-666666666666",
            environment: "sandbox",
            institution: {
              institutionId: "ins-6",
              institutionName: "Concurrency Bank",
              primaryAccountMask: null,
              accounts: [],
            },
          });
        }
        if (url.endsWith("/sync")) {
          syncRequest += 1;
          const cursor = (JSON.parse(String(init?.body)) as { cursor: string })
            .cursor;
          requestedCursors.push(cursor);
          if (syncRequest === 1) {
            return new Promise<Response>((resolve) => {
              releaseFirst = resolve;
            });
          }
          if (syncRequest === 2) {
            return Response.json({
              added: [plaidTransaction("newer-window", { amount: 22 })],
              modified: [],
              removed: [],
              nextCursor: "cursor-newer",
              hasMore: false,
            });
          }
          return Response.json({
            added: [plaidTransaction("replayed-window", { amount: 33 })],
            modified: [],
            removed: [],
            nextCursor: "cursor-final",
            hasMore: false,
          });
        }
        return Response.json({ error: "unexpected route" }, { status: 500 });
      });

    try {
      service.plaidManagedClientCache = new PlaidManagedClient(() => ({
        configured: true,
        apiKey: "eliza_test",
        apiBaseUrl: "https://cloud.example/api/v1",
        siteUrl: "https://cloud.example",
      }));
      const source = await service.completePlaidLink({
        publicToken: "public-token",
      });
      const stale = service.syncPlaidTransactions({ sourceId: source.id });
      for (let attempt = 0; syncRequest < 1 && attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(syncRequest).toBe(1);
      const newer = service.syncPlaidTransactions({ sourceId: source.id });
      await expect(newer).resolves.toMatchObject({
        nextCursor: "cursor-newer",
      });
      releaseFirst?.(
        Response.json({
          added: [plaidTransaction("stale-window", { amount: 44 })],
          modified: [],
          removed: [],
          nextCursor: "cursor-stale",
          hasMore: false,
        }),
      );
      await expect(stale).resolves.toMatchObject({
        nextCursor: "cursor-final",
      });
      expect(requestedCursors).toEqual(["", "", "cursor-newer"]);
      const stored = await repository.getPaymentSource(
        runtime.agentId,
        source.id,
      );
      expect(stored?.metadata.plaid).toMatchObject({ cursor: "cursor-final" });
      const transactions = await repository.listPaymentTransactions(
        runtime.agentId,
        {
          sourceId: source.id,
        },
      );
      expect(
        transactions.map((transaction) => transaction.externalId).sort(),
      ).toEqual(["newer-window", "replayed-window"]);
    } finally {
      fetchSpy.mockRestore();
      service.plaidManagedClientCache = null;
    }
  });

  it("rolls back every Plaid sync write when a later transaction insert fails", async () => {
    const now = new Date().toISOString();
    const sourceId = crypto.randomUUID();
    const source = {
      id: sourceId,
      agentId: runtime.agentId,
      kind: "plaid" as const,
      label: "Atomicity Bank",
      institution: "Atomicity Bank",
      accountMask: null,
      status: "active" as const,
      lastSyncedAt: null,
      transactionCount: 0,
      metadata: { plaid: { connectionId: crypto.randomUUID(), cursor: "" } },
      createdAt: now,
      updatedAt: now,
    };
    await repository.upsertPaymentSource(source);
    const duplicateId = crypto.randomUUID();
    const buildRecord = (externalId: string) => ({
      id: duplicateId,
      agentId: runtime.agentId,
      sourceId,
      externalId,
      postedAt: now,
      amountUsd: 10,
      direction: "debit" as const,
      merchantRaw: "Rollback Merchant",
      merchantNormalized: "rollback merchant",
      description: null,
      category: null,
      currency: "USD",
      metadata: {},
      createdAt: now,
    });

    await expect(
      repository.applyPlaidSync({
        expectedCursor: "",
        source: {
          ...source,
          metadata: {
            plaid: { connectionId: crypto.randomUUID(), cursor: "new-cursor" },
          },
        },
        added: [buildRecord("rollback-one"), buildRecord("rollback-two")],
        modified: [],
        removedExternalIds: [],
      }),
    ).rejects.toThrow();
    await expect(
      repository.listPaymentTransactions(runtime.agentId, { sourceId }),
    ).resolves.toEqual([]);
    const persisted = await repository.getPaymentSource(
      runtime.agentId,
      sourceId,
    );
    expect(persisted?.metadata.plaid).toMatchObject({ cursor: "" });
    expect(persisted?.transactionCount).toBe(0);
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
