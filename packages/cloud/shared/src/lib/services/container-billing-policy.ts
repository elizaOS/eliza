/**
 * Pure billing-decision policy for the container-billing cron.
 *
 * The cron's hot path mixes side-effecting calls (DB writes, emails, earnings
 * conversion) with the decision of "how should we split this charge across
 * earnings vs credits, or do we need to warn the org instead?". Extracting
 * that decision into a pure function lets us prove the load-bearing rules
 * (pay-as-you-go pulls from earnings before credits; pay-as-you-go=off
 * preserves earnings; insufficient total triggers warning) without a real
 * database.
 *
 * Anything that mutates state stays in `container-billing/route.ts`. This
 * file only computes "what's the plan?".
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

/**
 * Decide how to split today's container charge between earnings and credits.
 *
 * Rules (the load-bearing survival-economics behavior):
 *  1. `payAsYouGoFromEarnings === false` → earnings stay frozen, charge comes
 *     purely from credits. Default when org owner opts out at
 *     /cloud/billing.
 *  2. `payAsYouGoFromEarnings === true` (default) → earnings absorb the bill
 *     first up to `dailyCost`, then credits cover the remainder. This is what
 *     keeps an earning agent self-funding ("survival economics" loop).
 *  3. If `earnings + credits < dailyCost`, return `action: "insufficient"`.
 *     The caller emits the 48-hour shutdown warning.
 *
 * Money math fails closed on garbage: non-finite inputs (NaN/±Infinity) in any
 * field and a negative `dailyCost` throw `ElizaError`
 * (`CONTAINER_BILLING_PLAN_INPUT_INVALID`) instead of returning a NaN-bearing
 * plan — under float comparison a NaN `totalAvailable < dailyCost` is false,
 * so the pre-fix function silently returned `action: "billed"` with NaN debit
 * legs. A negative `currentBalance` falls through to the ordinary
 * `totalAvailable < dailyCost` insufficiency path instead of throwing: the
 * read at route.ts (`Number(org.credit_balance)`) has no other guard, so a
 * non-finite parse must throw here, while a finite negative must keep the
 * container on the warn/shutdown track rather than erroring the run.
 */
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
