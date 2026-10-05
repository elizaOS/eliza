/** Reads original immutable schedule lineage; publication rechecks the captured source under its existing organization lock. */
import { and, eq, isNull } from "drizzle-orm";
import { organizationPlanChangeProviderBindingSchema } from "../../lib/services/organization-plan-change-provider-binding";
import { renewalUnavailable } from "../../lib/services/stripe-paid-renewal-validation";
import type { Database, DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import type { BillingSubscription } from "../schemas/billing-subscriptions";
import { organizationPlanChangeQuotes } from "../schemas/organization-plan-change-quotes";
import { billingSubscriptionCommands as commands } from "../schemas/subscription-billing-operations";
export async function readOriginalScheduledRenewalAuthority(
  source: BillingSubscription,
  database: Database | DbTransaction = dbWrite,
) {
  if (source.pending_plan_key === null) return null;
  const candidates = await database
    .select()
    .from(commands)
    .where(
      and(
        eq(commands.organization_id, source.organization_id),
        eq(commands.subscription_id, source.id),
        eq(commands.result_subscription_revision, source.lifecycle_revision),
        eq(commands.kind, "downgrade"),
        eq(commands.status, "APPLIED"),
        eq(commands.target_plan_key, source.pending_plan_key),
        isNull(commands.app_id),
        isNull(commands.billing_scope_id),
      ),
    );
  if (candidates.length !== 1) renewalUnavailable("original_scheduled_target_missing");
  const command = candidates[0]!;
  const proof = command.organization_schedule_configuration_evidence;
  if (!proof || !command.organization_schedule_configuration_snapshot)
    renewalUnavailable("original_scheduled_snapshot_missing");
  const [quote] = await database
    .select()
    .from(organizationPlanChangeQuotes)
    .where(
      and(
        eq(organizationPlanChangeQuotes.organization_id, source.organization_id),
        eq(organizationPlanChangeQuotes.consumed_by_command_id, command.id),
        eq(organizationPlanChangeQuotes.id, proof.quoteId),
      ),
    );
  if (!quote) renewalUnavailable("original_scheduled_review_missing");
  const binding = organizationPlanChangeProviderBindingSchema.parse(quote.provider_binding);
  return {
    source,
    command,
    quoteId: quote.id,
    review: quote.review,
    providerBinding: binding,
    scheduleId: proof.scheduleId,
  };
}
