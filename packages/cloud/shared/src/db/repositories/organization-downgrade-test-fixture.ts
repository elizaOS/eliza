/** Reusable real-database lower-plan review fixture. */
import type { OrganizationDowngradeReview } from "../../lib/services/organization-downgrade-review";
import { seedCancellationTestAccount } from "./subscription-cancellation-test-fixture";
export async function seedOrganizationDowngradeTestAccount(
  query: (text: string, values: unknown[]) => Promise<unknown>,
  validityMs = 60000,
) {
  const f = await seedCancellationTestAccount(query, undefined, "pro_monthly");
  const { readOrganizationPlanChangeSource } = await import("./organization-plan-change");
  const captured = await readOrganizationPlanChangeSource(f.input);
  const now = new Date();
  const review: OrganizationDowngradeReview = {
    kind: "downgrade_estimate",
    subscriptionId: f.input.subscriptionId,
    expectedSubscriptionRevision: "1",
    sourcePlanKey: "pro_monthly",
    targetPlanKey: "plus_monthly",
    catalogVersion: "v1",
    currency: "usd",
    currentPeriodStart: f.source.current_period_start.toISOString(),
    currentPeriodEnd: f.source.current_period_end.toISOString(),
    effectiveAt: f.source.current_period_end.toISOString(),
    amountDueNowCents: 0,
    targetBaseAmountCents: 3000,
    targetAllowanceUsd: "25.000000",
    recurringEstimate: {
      amountDueCents: 3000,
      subtotalCents: 3000,
      discountCents: 0,
      taxCents: 0,
      totalCents: 3000,
      startingBalanceCents: 0,
    },
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + validityMs).toISOString(),
  };
  const { saveOrganizationDowngradeQuote } = await import("./organization-downgrade-quotes");
  const quote = await saveOrganizationDowngradeQuote({
    identity: f.input,
    captured,
    review,
    providerBinding: {
      sourcePriceId: "price_pro",
      targetPriceId: "price_plus",
      sourceProductId: "prod_pro",
      targetProductId: "prod_plus",
      livemode: false,
      apiVersion: "2024-11-20.acacia",
    },
  });
  return { ...f, quote };
}
