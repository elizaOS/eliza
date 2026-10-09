/** Retains a reviewed lower price only after its target revision and paid allowance were atomically published. */
import type {
  BillingSubscription,
  BillingSubscriptionRevision,
} from "../../db/schemas/billing-subscriptions";
import type { organizationPlanChangeQuotes } from "../../db/schemas/organization-plan-change-quotes";
import type { SubscriptionAllowancePeriod } from "../../db/schemas/subscription-allowance-periods";
import type { SubscriptionAllowanceTransaction } from "../../db/schemas/subscription-allowance-transactions";
import type { BillingSubscriptionCommand } from "../../db/schemas/subscription-billing-operations";
import { proveOriginalConfiguredAuthority } from "./organization-schedule-target-authority";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import { renewalUnavailable } from "./stripe-paid-renewal-validation";
import { SUBSCRIPTION_PAYMENT_GRACE_MS } from "./subscription-payment-grace";

function reject(): never {
  return renewalUnavailable("scheduled_paid_plan_binding_unverified");
}
export function proveScheduledPaidPlanBinding(input: {
  source: BillingSubscription;
  command: BillingSubscriptionCommand;
  quote: typeof organizationPlanChangeQuotes.$inferSelect;
  revisions: BillingSubscriptionRevision[];
  period: SubscriptionAllowancePeriod;
  grant: SubscriptionAllowanceTransaction;
}) {
  const { source, command, quote, revisions, period, grant } = input;
  assertOrganizationSubscription(source);
  const configured = revisions[1],
    original = revisions[0],
    last = revisions.at(-1);
  if (
    !configured ||
    !original ||
    !last ||
    command.expected_subscription_revision === null ||
    !Number.isSafeInteger(command.expected_subscription_revision) ||
    command.expected_subscription_revision < 1 ||
    !Number.isSafeInteger(source.lifecycle_revision) ||
    revisions.length !== source.lifecycle_revision - command.expected_subscription_revision + 1 ||
    configured.revision !== command.result_subscription_revision ||
    original.revision !== command.expected_subscription_revision ||
    quote.organization_id !== source.organization_id ||
    quote.subscription_id !== source.id ||
    quote.consumed_by_command_id !== command.id ||
    quote.subscription_revision !== original.revision ||
    quote.review_digest !== command.organization_schedule_configuration_evidence?.reviewDigest ||
    quote.source_digest !== command.organization_schedule_configuration_evidence?.sourceDigest ||
    quote.target_plan_key !== source.plan_key ||
    quote.catalog_version !== source.catalog_version ||
    original.pending_plan_key !== null ||
    original.plan_key !== configured.plan_key
  )
    reject();
  const authority = proveOriginalConfiguredAuthority({
    source: {
      ...configured,
      id: configured.subscription_id,
      lifecycle_revision: configured.revision,
    },
    command,
    quoteId: quote.id,
    review: quote.review,
    providerBinding: quote.provider_binding,
  });
  const paidIndex = revisions.findIndex(
    (row) =>
      row.revision > configured.revision &&
      row.plan_key === authority.targetPlanKey &&
      row.pending_plan_key === null,
  );
  const paid = revisions[paidIndex];
  if (
    paidIndex < 2 ||
    !paid ||
    source.plan_key !== authority.targetPlanKey ||
    !(paid.status === "active"
      ? paid.dunning_started_at === null && paid.grace_expires_at === null
      : ["grace", "past_due", "unpaid"].includes(paid.status) &&
        paid.dunning_started_at?.getTime() === authority.phase.end.getTime() &&
        paid.grace_expires_at?.getTime() ===
          authority.phase.end.getTime() + SUBSCRIPTION_PAYMENT_GRACE_MS) ||
    paid.cancel_at_period_end ||
    paid.ended_at !== null ||
    paid.current_period_start.getTime() !== authority.phase.start.getTime() ||
    paid.current_period_end.getTime() !== authority.phase.end.getTime()
  )
    reject();
  for (const [index, row] of revisions.entries()) {
    if (
      row.revision !== command.expected_subscription_revision + index ||
      row.organization_id !== source.organization_id ||
      row.subscription_id !== source.id ||
      row.billing_scope_id !== null ||
      row.merchant_key !== "platform" ||
      row.provider !== "stripe" ||
      row.provider_environment !== source.provider_environment ||
      row.stripe_customer_id !== source.stripe_customer_id ||
      row.stripe_subscription_id !== source.stripe_subscription_id ||
      row.catalog_version !== source.catalog_version ||
      row.quantity !== source.quantity
    )
      reject();
    if (
      index < 2 &&
      (row.status !== "active" || row.dunning_started_at !== null || row.grace_expires_at !== null)
    )
      reject();
    if (index < paidIndex) {
      if (
        row.plan_key !== original.plan_key ||
        row.stripe_subscription_item_id !== configured.stripe_subscription_item_id ||
        row.current_period_start.getTime() !== original.current_period_start.getTime() ||
        row.current_period_end.getTime() !== original.current_period_end.getTime() ||
        (index > 0 && row.pending_plan_key !== authority.targetPlanKey) ||
        row.cancel_at_period_end ||
        row.ended_at !== null ||
        !["active", "grace", "past_due", "unpaid"].includes(row.status)
      )
        reject();
    } else if (
      row.plan_key !== source.plan_key ||
      row.stripe_subscription_item_id !== source.stripe_subscription_item_id
    )
      reject();
  }
  if (
    period.organization_id !== source.organization_id ||
    period.subscription_id !== source.id ||
    period.subscription_revision !== paid.revision ||
    period.billing_scope_id !== null ||
    period.merchant_key !== "platform" ||
    period.provider !== "stripe" ||
    period.provider_environment !== source.provider_environment ||
    period.grant_source !== "paid_invoice" ||
    !period.stripe_invoice_id ||
    period.plan_key !== authority.targetPlanKey ||
    period.catalog_version !== source.catalog_version ||
    period.period_start.getTime() !== authority.phase.start.getTime() ||
    period.period_end.getTime() !== authority.phase.end.getTime() ||
    period.expires_at.getTime() !== period.period_end.getTime() ||
    period.granted_amount !== authority.targetAllowanceUsd ||
    grant.organization_id !== source.organization_id ||
    grant.allowance_period_id !== period.id ||
    grant.billing_scope_id !== null ||
    grant.merchant_key !== "platform" ||
    grant.kind !== "grant" ||
    grant.sequence !== 1 ||
    grant.amount !== authority.targetAllowanceUsd ||
    !/^[a-f0-9]{64}$/.test(grant.request_digest) ||
    grant.idempotency_key !== `renewal:${source.provider_environment}:${period.stripe_invoice_id}`
  )
    reject();
  for (const key of [
    "plan_key",
    "pending_plan_key",
    "status",
    "provider_object_digest",
    "cancel_at_period_end",
    "quantity",
  ] as const)
    if (last[key] !== source[key]) reject();
  for (const key of [
    "current_period_start",
    "current_period_end",
    "canceled_at",
    "ended_at",
    "dunning_started_at",
    "grace_expires_at",
  ] as const)
    if (last[key]?.getTime() !== source[key]?.getTime()) reject();
  return authority.binding;
}
