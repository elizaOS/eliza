/**
 * Discriminating regression test for the admission advisory lock (#9899).
 *
 * The HARD concurrent-overdraw bound rests on `admitInferenceChargeViaLedger`
 * taking a per-org `pg_advisory_xact_lock` BEFORE it reads the cross-table
 * in-flight `SUM` (so each admission reads the SUM only after concurrent ones
 * commit). Single-connection PGlite serializes every statement, so the behavioral
 * suite in `inference-billing-ledger.test.ts` passes IDENTICALLY whether the lock
 * is present, removed, or moved after the SUM — it cannot catch a regression that
 * re-breaks the lock.
 *
 * This suite closes that gap WITHOUT a real multi-connection Postgres, the same
 * way `signup-grant-guard.test.ts` does for its lock: it mocks the transaction,
 * records the SQL each statement runs, and asserts the advisory lock is acquired
 * with the correct per-org key and STRICTLY BEFORE the in-flight SUM read. Drop
 * the lock, or move it after the `SELECT … SUM(estimated_cost_usd)`, and this
 * fails.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import * as helpersActual from "../../db/helpers";

const executedSql: string[] = [];

function sqlText(query: unknown): string {
  // drizzle `sql` templates carry their static text in `queryChunks`; stringifying
  // is enough to recognize which statement ran and to scan bound params.
  return JSON.stringify(query);
}

/** A transaction stand-in: records every statement and returns shapes the
 * admission SQL consumer (`sqlRows`) accepts so the gate resolves to "admitted". */
class FakeTx {
  async execute(query: unknown): Promise<{ rows: Array<Record<string, unknown>> }> {
    const text = sqlText(query);
    executedSql.push(text);
    if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
    // The admission's single WITH … SELECT — return an org that exists + an
    // admitted request id so the function reports `admitted: true`.
    return { rows: [{ org_exists: true, admitted_request_id: "req-lock-test" }] };
  }
}

// Mock ONLY the transaction seam; `sqlRows` (execute-helpers) is left real and
// just calls `tx.execute`. `dbWrite` is a stub — the sweep/settle aren't exercised.
const writeTransaction = mock(async (fn: (tx: FakeTx) => Promise<unknown>) => fn(new FakeTx()));
// Spread the real module so other named exports (dbRead, useReadDb, …) still
// resolve — a partial mock.module throws "Export not found" (bun link error).
mock.module("../../db/helpers", () => ({
  ...helpersActual,
  writeTransaction,
  dbWrite: { execute: async () => ({ rows: [] }) },
}));

mock.module("../utils/logger", () => ({
  logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
}));

const { admitInferenceChargeViaLedger } = await import("./inference-billing-ledger");

afterEach(() => {
  executedSql.length = 0;
  writeTransaction.mockClear();
});

const ORG = "00000000-0000-0000-0000-00000000a10c";

function admit() {
  return admitInferenceChargeViaLedger({
    charge: {
      requestId: "req-lock-test",
      organizationId: ORG,
      userId: "00000000-0000-0000-0000-00000000a10d",
      apiKeyId: null,
      model: "gpt-oss-120b",
      provider: "cerebras",
      billingSource: "platform",
    },
    estimatedCostUsd: 1,
    thresholdUsd: 0.5,
  });
}

describe("admission advisory lock (#9899 — discriminates the overdraw-bound lock)", () => {
  test("runs inside a transaction and acquires the per-org advisory lock BEFORE the in-flight SUM", async () => {
    const res = await admit();
    expect(res.admitted).toBe(true);

    // It must use a transaction (where the xact lock lives) — not an auto-commit.
    expect(writeTransaction).toHaveBeenCalledTimes(1);

    const lockIdx = executedSql.findIndex((s) => s.includes("pg_advisory_xact_lock"));
    const sumIdx = executedSql.findIndex((s) => s.includes("SUM(estimated_cost_usd)"));

    // The lock is present...
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    // ...the in-flight SUM is present...
    expect(sumIdx).toBeGreaterThanOrEqual(0);
    // ...and the lock is taken STRICTLY BEFORE the SUM (the load-bearing order:
    // reading the SUM before the lock would re-open the stale-snapshot race).
    expect(lockIdx).toBeLessThan(sumIdx);
  });

  test("scopes the advisory lock to THIS org (per-org serialization, not a global lock)", async () => {
    await admit();
    const lockStmt = executedSql.find((s) => s.includes("pg_advisory_xact_lock"));
    expect(lockStmt).toBeDefined();
    // The lock key embeds the org id so distinct orgs never serialize against
    // each other (a global lock would needlessly serialize all inference).
    expect(lockStmt).toContain("inference_admit:");
    expect(lockStmt).toContain(ORG);
  });
});
