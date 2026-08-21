/**
 * Audits every production credit debit/reservation and low-level balance or
 * ledger write against the review-owned subscription funding inventory. The
 * scanner is intentionally syntax-oriented and deterministic so a new bypass
 * cannot hide behind a newly named product service.
 */

import { describe, expect, test } from "bun:test";
import {
  scanProductionSubscriptionDebitInventory,
  scanSubscriptionDebitSignals,
} from "../../../scripts/audit-subscription-funding-debits";
import {
  SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION,
  SUBSCRIPTION_FUNDING_DEBIT_BOUNDARIES,
} from "./subscription-funding-policy";

describe("subscription funding production debit inventory", () => {
  test("detects raw balance and ledger bypass shapes", () => {
    expect(
      scanSubscriptionDebitSignals(`
        await tx.update(organizations).set({
          credit_balance: sql\`${"${organizations.credit_balance}"} - ${"${amount}"}\`,
        });
        await tx.insert(creditTransactions).values({ type: "debit" });
        await tx.execute(sql\`INSERT INTO credit_transactions (type) VALUES ('debit')\`);
      `),
    ).toEqual({
      debit_ledger_literal: 1,
      raw_credit_balance_decrement: 1,
      raw_credit_transaction_sql_insert: 1,
      raw_credit_transaction_insert: 1,
    });
  });

  test("matches the reviewed production call graph exactly", () => {
    const reviewed = Object.fromEntries(
      SUBSCRIPTION_FUNDING_DEBIT_BOUNDARIES.map((entry) => [
        entry.relativePath,
        entry.expectedSignals,
      ]),
    );
    expect(scanProductionSubscriptionDebitInventory()).toEqual(reviewed);
  });

  test("pins every boundary to the server-owned operation class", () => {
    for (const entry of SUBSCRIPTION_FUNDING_DEBIT_BOUNDARIES) {
      expect(entry.fundingClass).toBe(SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION[entry.operation]);
    }
  });
});
