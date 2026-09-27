/**
 * Ratchets every production purchased-credit debit boundary against the
 * reviewed subscription funding inventory. A new direct debit, reservation or
 * raw balance decrement anywhere in Cloud production code fails this suite
 * until it is classified, and an allowance-eligible boundary that does not
 * route through allowance-first funding fails even if its counts match.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLOUD_ROOT,
  scanProductionSubscriptionDebitInventory,
  scanSubscriptionDebitSignals,
} from "../../../../scripts/shared/audit-subscription-funding-debits";
import {
  SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION,
  SUBSCRIPTION_FUNDING_DEBIT_BOUNDARIES,
} from "./subscription-funding-policy";

/** Source markers proving a boundary consults allowance-first funding. */
const ALLOWANCE_FIRST_ROUTING =
  /\bsubscriptionFundingService\b|\ballowance-first-credits\b|\bagentComputeFundingService\b/;

describe("subscription funding debit boundaries", () => {
  const inventory = scanProductionSubscriptionDebitInventory();

  test("every production debit signal is a reviewed boundary with exact counts", () => {
    const reviewed = Object.fromEntries(
      SUBSCRIPTION_FUNDING_DEBIT_BOUNDARIES.map((boundary) => [
        boundary.relativePath,
        boundary.expectedSignals,
      ]),
    );
    expect(inventory).toEqual(reviewed);
  });

  test("reviewed boundaries are unique and classified by the closed policy", () => {
    const paths = SUBSCRIPTION_FUNDING_DEBIT_BOUNDARIES.map((boundary) => boundary.relativePath);
    expect(new Set(paths).size).toBe(paths.length);
    for (const boundary of SUBSCRIPTION_FUNDING_DEBIT_BOUNDARIES) {
      expect({ path: boundary.relativePath, fundingClass: boundary.fundingClass }).toEqual({
        path: boundary.relativePath,
        fundingClass: SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION[boundary.operation],
      });
    }
  });

  test("allowance-eligible boundaries route subscribers through allowance-first funding", () => {
    const unrouted = SUBSCRIPTION_FUNDING_DEBIT_BOUNDARIES.filter((boundary) => {
      if (boundary.fundingClass !== "allowance_eligible") return false;
      const router = "routedBy" in boundary ? boundary.routedBy : undefined;
      return !ALLOWANCE_FIRST_ROUTING.test(
        readFileSync(resolve(CLOUD_ROOT, router ?? boundary.relativePath), "utf8"),
      );
    }).map((boundary) => boundary.relativePath);
    expect(unrouted).toEqual([]);
  });

  test("the scanner counts direct debit forms and ignores comments and strings", () => {
    expect(
      scanSubscriptionDebitSignals(`
        // creditsService.deductCredits({ amount: 1 })
        const note = "creditsService.reserve(";
        await creditsService.deductCredits({ amount: 1 });
        await this.credits.reserve({ amount: 1 });
        await tx.insert(creditTransactions).values({ type: "debit" });
        await tx.execute(sql\`UPDATE organizations SET credit_balance = credit_balance - 1\`);
      `),
    ).toEqual({
      credit_service_deduct: 1,
      credit_service_reserve: 1,
      debit_ledger_literal: 1,
      raw_credit_balance_decrement: 1,
      raw_credit_transaction_insert: 1,
    });
  });
});
