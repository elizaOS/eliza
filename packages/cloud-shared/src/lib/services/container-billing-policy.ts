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
 *     /dashboard/billing.
 *  2. `payAsYouGoFromEarnings === true` (default) → earnings absorb the bill
 *     first up to `dailyCost`, then credits cover the remainder. This is what
 *     keeps an earning agent self-funding ("survival economics" loop).
 *  3. If `earnings + credits < dailyCost`, return `action: "insufficient"`.
 *     The caller emits the 48-hour shutdown warning.
 */
export function computeContainerBillingPlan(
  input: ContainerBillingPlanInput,
): ContainerBillingPlan {
  const { dailyCost, currentBalance, ownerEarningsAvailable, payAsYouGoFromEarnings } = input;

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
