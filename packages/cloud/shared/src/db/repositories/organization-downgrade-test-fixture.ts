/** Reusable real-database lower-plan review fixture. */

import type { OrganizationDowngradeReview } from "../../lib/services/organization-downgrade-review";
import { captureOrganizationScheduleQuoteTerms } from "../../lib/services/organization-schedule-quote-terms";
import {
  completeScheduleSubscriptionTestObservation,
  scheduleCustomerTestObservation,
} from "../../lib/services/organization-schedule-test-fixture";
import { seedCancellationTestAccount } from "./subscription-cancellation-test-fixture";
export async function buildOrganizationDowngradeTestAccount(
  query: (text: string, values: unknown[]) => Promise<unknown>,
  validityMs = 60000,
  period?: { start: Date; end: Date },
) {
  const f = await seedCancellationTestAccount(query, period, "pro_monthly");
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
    expiresAt: new Date(
      Math.min(now.getTime() + validityMs, f.source.current_period_end.getTime()),
    ).toISOString(),
  };
  const retainedTerms = captureOrganizationScheduleQuoteTerms({
    rawSubscription: completeScheduleSubscriptionTestObservation(f.provider),
    rawCustomer: scheduleCustomerTestObservation(f.source.stripe_customer_id),
    observedAt: now,
  });
  const providerBinding = {
    sourcePriceId: "price_pro",
    targetPriceId: "price_plus",
    sourceProductId: "prod_pro",
    targetProductId: "prod_plus",
    livemode: false,
    apiVersion: "2024-11-20.acacia" as const,
  };
  return { ...f, captured, review, retainedTerms, providerBinding };
}
export async function seedOrganizationDowngradeTestAccount(
  query: (text: string, values: unknown[]) => Promise<unknown>,
  validityMs = 60000,
  period?: { start: Date; end: Date },
) {
  const f = await buildOrganizationDowngradeTestAccount(query, validityMs, period);
  const { saveOrganizationDowngradeQuote } = await import("./organization-downgrade-quotes");
  const quote = await saveOrganizationDowngradeQuote({
    identity: f.input,
    captured: f.captured,
    review: f.review,
    retainedTerms: f.retainedTerms,
    providerBinding: f.providerBinding,
  });
  return { ...f, quote };
}
