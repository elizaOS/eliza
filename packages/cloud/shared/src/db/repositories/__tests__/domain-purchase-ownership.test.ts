/**
 * Real-DB coverage for `hasUnrefundedDomainPurchase` — the ownership proof that
 * gates orphan-domain recovery in the buy route (#10253).
 *
 * When a domain's post-register persist fails, the domain is registered on our
 * Cloudflare account + the org is charged, but there is no `managed_domains`
 * row. The recovery branch will assign such a registered-but-unrowed domain
 * WITHOUT a fresh debit — so it must first confirm the caller actually paid and
 * was not refunded, or any org could grab another org's orphan for free. The
 * single source of that truth is the credit ledger: a `domain_purchase` debit
 * for the domain that outnumbers its `domain_purchase_refund`s.
 *
 * Runs the REAL count SQL against in-process PGlite. Self-skips if unavailable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

const PGLITE_TIMEOUT = 60000;
const ORG_A = "00000000-0000-0000-0000-0000000000a1";
const ORG_B = "00000000-0000-0000-0000-0000000000b1";

let dbWrite: typeof import("../../client").dbWrite;
let closeDb: typeof import("../../client").closeDatabaseConnectionsForTests | undefined;
let repo: typeof import("../credit-transactions").creditTransactionsRepository;
let pgliteReady = true;

let txnSeq = 0;
async function addTxn(org: string, type: string, metadata: Record<string, unknown>): Promise<void> {
  txnSeq += 1;
  const meta = JSON.stringify(metadata).replace(/'/g, "''");
  await dbWrite.execute(
    `INSERT INTO credit_transactions (id, organization_id, amount, type, metadata)
     VALUES (gen_random_uuid(), '${org}', '${txnSeq}', '${type}', '${meta}'::jsonb);`,
  );
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../client"));
    ({ creditTransactionsRepository: repo } = await import("../credit-transactions"));
    await dbWrite.execute(
      `CREATE TABLE IF NOT EXISTS credit_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        user_id uuid,
        amount numeric(12,6) NOT NULL,
        type text NOT NULL,
        description text,
        metadata jsonb NOT NULL DEFAULT '{}',
        stripe_payment_intent_id text,
        created_at timestamp NOT NULL DEFAULT now()
      )`,
    );
  } catch (error) {
    pgliteReady = false;
    console.warn("[domain-purchase-ownership] PGlite unavailable, skipping:", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("hasUnrefundedDomainPurchase", () => {
  beforeEach(async () => {
    expect(pgliteReady).toBe(true);
    await dbWrite.execute(`DELETE FROM credit_transactions;`);
  });

  test("no transactions → false", async () => {
    expect(pgliteReady).toBe(true);
    expect(await repo.hasUnrefundedDomainPurchase(ORG_A, "example.com")).toBe(false);
  });

  test("an unrefunded domain_purchase debit → true", async () => {
    expect(pgliteReady).toBe(true);
    await addTxn(ORG_A, "debit", { type: "domain_purchase", domain: "example.com" });
    expect(await repo.hasUnrefundedDomainPurchase(ORG_A, "example.com")).toBe(true);
  });

  test("debit fully refunded → false", async () => {
    expect(pgliteReady).toBe(true);
    await addTxn(ORG_A, "debit", { type: "domain_purchase", domain: "example.com" });
    await addTxn(ORG_A, "refund", { type: "domain_purchase_refund", domain: "example.com" });
    expect(await repo.hasUnrefundedDomainPurchase(ORG_A, "example.com")).toBe(false);
  });

  test("re-purchased after a refund (debits > refunds) → true", async () => {
    expect(pgliteReady).toBe(true);
    await addTxn(ORG_A, "debit", { type: "domain_purchase", domain: "example.com" });
    await addTxn(ORG_A, "refund", { type: "domain_purchase_refund", domain: "example.com" });
    await addTxn(ORG_A, "debit", { type: "domain_purchase", domain: "example.com" });
    expect(await repo.hasUnrefundedDomainPurchase(ORG_A, "example.com")).toBe(true);
  });

  test("a different org's purchase does not grant ownership", async () => {
    expect(pgliteReady).toBe(true);
    await addTxn(ORG_A, "debit", { type: "domain_purchase", domain: "example.com" });
    // Org B never bought example.com — must be denied (cross-tenant guard).
    expect(await repo.hasUnrefundedDomainPurchase(ORG_B, "example.com")).toBe(false);
  });

  test("a purchase of a different domain does not match", async () => {
    expect(pgliteReady).toBe(true);
    await addTxn(ORG_A, "debit", { type: "domain_purchase", domain: "other.com" });
    expect(await repo.hasUnrefundedDomainPurchase(ORG_A, "example.com")).toBe(false);
  });
});
