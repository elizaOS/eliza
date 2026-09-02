/**
 * Audits every production credit debit/reservation and low-level balance or
 * ledger write against the review-owned subscription funding inventory. The
 * scanner is intentionally syntax-oriented and deterministic so a new bypass
 * cannot hide behind a newly named product service.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  scanProductionSubscriptionDebitInventory,
  scanSubscriptionDebitSignals,
} from "../../../scripts/audit-subscription-funding-debits";
import {
  SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION,
  SUBSCRIPTION_FUNDING_DEBIT_BOUNDARIES,
} from "./subscription-funding-policy";

setDefaultTimeout(30_000);

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

  test("detects balance decrements across long expressions", () => {
    const longExpressionPrefix = "WHEN balance_is_pending THEN balance ".repeat(40);
    expect(
      scanSubscriptionDebitSignals(`
        credit_balance: sql\`
          CASE ${longExpressionPrefix}
          ELSE \${organizations.credit_balance} - \${amount}
          END
        \`,
      `),
    ).toEqual({ raw_credit_balance_decrement: 1 });
  });

  test("detects raw balance decrements without author-controlled whitespace", () => {
    expect(
      scanSubscriptionDebitSignals(`
        credit_balance: sql\`${"${organizations.credit_balance}"}-${"${amount}"}\`,
        await tx.execute(sql\`UPDATE organizations SET credit_balance=credit_balance-${"${amount}"}\`);
      `),
    ).toEqual({ raw_credit_balance_decrement: 2 });
  });

  test("ignores debit-shaped prose and quoted strings", () => {
    expect(
      scanSubscriptionDebitSignals(`
        const query = sql\`SELECT \${account.id} FROM accounts\`; // await creditsService.deductCredits(account.id, 1);
        // credit_balance = organizations.credit_balance - amount;
        /* await renamedOrganizationsRepository.deductCreditsWithTransaction({ amount: 3 }); */
        /** type: "debit" */
        const example = "credit_balance = organizations.credit_balance - amount";
        const pattern = /credit_balance = organizations.credit_balance - amount/;
      `),
    ).toEqual({});
  });

  test("detects renamed credit-service receivers", () => {
    expect(
      scanSubscriptionDebitSignals(`
        await usageCreditsService.deductCredits({ amount: 1 });
        await billingCredits.reserve({ amount: 1 });
        await this.credits.reserve({ amount: 1 });
        await billingAuthority.reserveAndDeductCredits({ amount: 2 });
        await renamedOrganizationsRepository.deductCreditsWithTransaction({ amount: 3 });
      `),
    ).toEqual({
      credit_service_deduct: 1,
      credit_service_reserve: 2,
      credit_service_reserve_and_deduct: 1,
      organization_repository_deduct: 1,
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

  test("requires every classified operation to have a reviewed debit boundary", () => {
    const reviewedOperations: ReadonlySet<string> = new Set(
      SUBSCRIPTION_FUNDING_DEBIT_BOUNDARIES.map((entry) => entry.operation),
    );
    expect(
      Object.keys(SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION).filter(
        (operation) => !reviewedOperations.has(operation),
      ),
    ).toEqual([]);
  });
});
