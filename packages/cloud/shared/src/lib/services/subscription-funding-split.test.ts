/**
 * Verifies the exact source allocation used before the transactional funding
 * writer touches either subscription allowance or purchased credits.
 */
import { describe, expect, test } from "bun:test";
import { microsToMoney } from "../../db/repositories/subscription-funding-reservations";
import {
  capSubscriptionFundingSettlement,
  splitSubscriptionFundingSources,
} from "./subscription-funding";

describe("subscription funding source split", () => {
  test("uses allowance first and sends only the remainder to purchased credits", () => {
    expect(
      splitSubscriptionFundingSources({
        requestedAmount: microsToMoney(12_500_000n),
        availableAllowance: microsToMoney(5_250_000n),
        fundingClass: "allowance_eligible",
      }),
    ).toEqual({
      allowanceAmount: "5.250000",
      purchasedCreditAmount: "7.250000",
    });
  });

  test("never exposes allowance to cash-only operations", () => {
    expect(
      splitSubscriptionFundingSources({
        requestedAmount: microsToMoney(3_000_000n),
        availableAllowance: microsToMoney(100_000_000n),
        fundingClass: "cash_only",
      }),
    ).toEqual({
      allowanceAmount: "0.000000",
      purchasedCreditAmount: "3.000000",
    });
  });

  test("does not require a purchased-credit leg when allowance covers the charge", () => {
    expect(
      splitSubscriptionFundingSources({
        requestedAmount: microsToMoney(750_000n),
        availableAllowance: microsToMoney(1_000_000n),
        fundingClass: "allowance_eligible",
      }),
    ).toEqual({
      allowanceAmount: "0.750000",
      purchasedCreditAmount: "0.000000",
    });
  });
});

describe("subscription funding settlement cap", () => {
  test("settles the reserved amount and reports excess usage without a second charge", () => {
    expect(
      capSubscriptionFundingSettlement({
        requestedActualAmount: microsToMoney(1_500_000n),
        reservedAmount: microsToMoney(1_000_000n),
      }),
    ).toEqual({
      collectedAmount: "1.000000",
      uncollectedOverageAmount: "0.500000",
    });
  });

  test("reports no overage when the reservation covers actual usage", () => {
    expect(
      capSubscriptionFundingSettlement({
        requestedActualAmount: microsToMoney(750_000n),
        reservedAmount: microsToMoney(1_000_000n),
      }),
    ).toEqual({
      collectedAmount: "0.750000",
      uncollectedOverageAmount: "0.000000",
    });
  });
});
