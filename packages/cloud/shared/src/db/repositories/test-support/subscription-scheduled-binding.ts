/** Exercises retained paid authority using rows produced by the actual PostgreSQL finalizer. */
import { expect } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { BillingSubscription } from "../../schemas/billing-subscriptions";

export async function assertScheduledPaidBinding(source: BillingSubscription, commandId: string) {
  const { dbWrite } = await import("../../helpers");
  const { billingSubscriptionCommands } = await import(
    "../../schemas/subscription-billing-operations"
  );
  const { organizationPlanChangeQuotes } = await import(
    "../../schemas/organization-plan-change-quotes"
  );
  const { subscriptionAllowancePeriods } = await import(
    "../../schemas/subscription-allowance-periods"
  );
  const { subscriptionAllowanceTransactions } = await import(
    "../../schemas/subscription-allowance-transactions"
  );
  const { subscriptionAuthorityRepository: authority } = await import("../subscription-authority");
  const { findSubscriptionRenewalBinding } = await import("../subscription-purchased-binding");
  const { proveScheduledPaidPlanBinding: prove } = await import(
    "../../../lib/services/subscription-scheduled-plan-binding"
  );
  const [command] = await dbWrite
    .select()
    .from(billingSubscriptionCommands)
    .where(
      and(
        eq(billingSubscriptionCommands.id, commandId),
        eq(billingSubscriptionCommands.organization_id, source.organization_id),
      ),
    );
  const [quote] = await dbWrite
    .select()
    .from(organizationPlanChangeQuotes)
    .where(
      and(
        eq(organizationPlanChangeQuotes.consumed_by_command_id, commandId),
        eq(organizationPlanChangeQuotes.organization_id, source.organization_id),
      ),
    );
  const revisions = await authority.listRevisions(source.organization_id, source.id);
  const [period] = await dbWrite
    .select()
    .from(subscriptionAllowancePeriods)
    .where(
      and(
        eq(subscriptionAllowancePeriods.organization_id, source.organization_id),
        eq(subscriptionAllowancePeriods.subscription_id, source.id),
        eq(subscriptionAllowancePeriods.subscription_revision, source.lifecycle_revision),
      ),
    );
  if (!command || !quote || !period) throw new Error("Paid scheduled fixture authority missing");
  const [grant] = await dbWrite
    .select()
    .from(subscriptionAllowanceTransactions)
    .where(
      and(
        eq(subscriptionAllowanceTransactions.organization_id, source.organization_id),
        eq(subscriptionAllowanceTransactions.allowance_period_id, period.id),
        eq(subscriptionAllowanceTransactions.kind, "grant"),
      ),
    );
  if (!grant) throw new Error("Paid scheduled fixture grant missing");
  const input = { source, command, quote, revisions, period, grant };
  expect(prove(input).targetPriceId).toBe("price_plus");
  const resolved = await findSubscriptionRenewalBinding(source, {
    STRIPE_PLUS_MONTHLY_PRICE_ID: "price_rotated",
    STRIPE_PLUS_PRODUCT_ID: "prod_rotated",
  });
  expect(resolved.environment.STRIPE_PLUS_MONTHLY_PRICE_ID).toBe("price_plus");
  expect(resolved.environment.STRIPE_PLUS_PRODUCT_ID).toBe("prod_plus");
  for (const changed of [
    { ...input, revisions: revisions.slice(1) },
    { ...input, revisions: revisions.filter((_, index) => index !== 1) },
    { ...input, source: { ...source, provider_object_digest: "f".repeat(64) } },
    { ...input, quote: { ...quote, consumed_by_command_id: crypto.randomUUID() } },
    { ...input, command: { ...command, organization_schedule_configuration_snapshot: null } },
    { ...input, period: { ...period, subscription_revision: period.subscription_revision - 1 } },
    {
      ...input,
      period: { ...period, period_start: new Date(period.period_start.getTime() + 1000) },
    },
    { ...input, period: { ...period, granted_amount: "100.000000" } },
    { ...input, grant: { ...grant, organization_id: crypto.randomUUID() } },
    { ...input, grant: { ...grant, allowance_period_id: crypto.randomUUID() } },
    { ...input, grant: { ...grant, amount: "100.000000" } },
    { ...input, grant: { ...grant, idempotency_key: "renewal:test:in_foreign" } },
  ])
    expect(() => prove(changed)).toThrow();
  // Spending the original allowance does not revoke the reviewed recurring price.
  expect(
    prove({
      ...input,
      period: { ...period, available_amount: "0.000000", settled_amount: period.granted_amount },
    }).targetPriceId,
  ).toBe("price_plus");
}
