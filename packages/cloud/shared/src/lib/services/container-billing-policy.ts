/**
 * Computes preliminary funding availability for the container-billing cron.
 * Invalid monetary inputs fail before route-side warning or stop requests;
 * the repository independently settles authoritative charges using Decimal.
 */

import { ElizaError } from "@elizaos/core";

export interface ContainerBillingPlanInput {
  /** Today's container cost in USD (already calculated from cpu/memory tier). */
  dailyCost: number;
  /** Org's current credit balance in USD. */
  currentBalance: number;
  /** Owner user's available redeemable-earnings balance in USD. */
  ownerEarningsAvailable: number;
  /** Org-level toggle (default true). When false, earnings stay untouched. */
  payAsYouGoFromEarnings: boolean;
}

export type ContainerBillingAction = "billed" | "insufficient";

export interface ContainerBillingPlan {
  action: ContainerBillingAction;
  /** Earnings portion to convert via redeemableEarningsService. */
  fromEarnings: number;
  /** Credit portion to debit from the org's credit_balance. */
  fromCredits: number;
  /** earnings + credits eligible for this charge (after the pay-as-you-go toggle). */
  totalAvailable: number;
  /** ownerEarningsAvailable when the toggle is on; 0 when off. */
  earningsEligible: number;
}

/** Validates monetary inputs and applies the organization's earnings opt-out. */
export function computeContainerBillingPlan(
  input: ContainerBillingPlanInput,
): ContainerBillingPlan {
  const { dailyCost, currentBalance, ownerEarningsAvailable, payAsYouGoFromEarnings } = input;

  for (const [field, value] of Object.entries({
    dailyCost,
    currentBalance,
    ownerEarningsAvailable,
  })) {
    if (!Number.isFinite(value)) {
      throw new ElizaError(
        `Container billing plan input ${field} must be a finite number, received ${value}`,
        {
          code: "CONTAINER_BILLING_PLAN_INPUT_INVALID",
          context: {
            field,
            value,
            dailyCost,
            currentBalance,
            ownerEarningsAvailable,
          },
          severity: "fatal",
        },
      );
    }
  }
  if (dailyCost < 0) {
    throw new ElizaError(
      `Container billing plan input dailyCost must be >= 0, received ${dailyCost}`,
      {
        code: "CONTAINER_BILLING_PLAN_INPUT_INVALID",
        context: { field: "dailyCost", value: dailyCost },
        severity: "fatal",
      },
    );
  }
  if (ownerEarningsAvailable < 0) {
    // Negative earnings are invalid data, not a live state:
    // redeemable_earnings.available_balance is CHECK-constrained >= 0
    // (0000_last_reavers.sql, `available_balance_non_negative`). This guard is
    // defense-in-depth — getAvailableEarnings already throws on non-finite
    // parses — and deliberately validates even when the toggle is off, because
    // the input contract validates every field regardless of whether this
    // call reads it (pinned by the suite).
    throw new ElizaError(
      `Container billing plan input ownerEarningsAvailable must be >= 0, received ${ownerEarningsAvailable}`,
      {
        code: "CONTAINER_BILLING_PLAN_INPUT_INVALID",
        context: {
          field: "ownerEarningsAvailable",
          value: ownerEarningsAvailable,
        },
        severity: "fatal",
      },
    );
  }

  const earningsEligible = payAsYouGoFromEarnings ? ownerEarningsAvailable : 0;
  const totalAvailable = currentBalance + earningsEligible;

  if (totalAvailable < dailyCost) {
    return {
      action: "insufficient",
      fromEarnings: 0,
      fromCredits: 0,
      totalAvailable,
      earningsEligible,
    };
  }

  const fromEarnings = Math.min(earningsEligible, dailyCost);
  const fromCredits = dailyCost - fromEarnings;

  return {
    action: "billed",
    fromEarnings,
    fromCredits,
    totalAvailable,
    earningsEligible,
  };
}

/** The billing window a single charge covers. */
export interface ContainerBillingPeriod {
  /** Inclusive start of the period (UTC midnight of the run day). */
  periodStart: Date;
  /** Exclusive end of the period (the next UTC midnight). */
  periodEnd: Date;
}

/**
 * Normalize a billing run timestamp to a deterministic, calendar-day-aligned
 * period. Container billing is a daily model, so the period a charge covers is
 * the UTC day it runs in — independent of the exact minute the cron fired.
 *
 * This determinism is load-bearing for idempotency: re-running the cron on the
 * same UTC day yields the same `periodStart`, so the earnings-conversion
 * idempotency key and the `container_billing_records(container_id,
 * billing_period_start)` unique index both collide and prevent a double-debit.
 */
export function computeContainerBillingPeriod(now: Date): ContainerBillingPeriod {
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const periodEnd = new Date(periodStart.getTime() + 24 * 60 * 60 * 1000);
  return { periodStart, periodEnd };
}
