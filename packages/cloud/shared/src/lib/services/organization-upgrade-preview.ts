/** Read-only provider review for organization upgrades. No subscription mutation or funding. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { readOrganizationPlanChangeSource } from "../../db/repositories/organization-plan-change";
import type { OrganizationSubscriptionSourceInput } from "../../db/repositories/organization-subscription-manager";
import { saveOrganizationUpgradeQuote } from "../../db/repositories/organization-upgrade-quotes";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { requireStripe } from "../stripe";
import { GENERIC_BILLING_STRIPE_API_VERSION } from "./generic-billing-provider-types";
import { organizationUpgradeReviewSchema } from "./organization-plan-change-contract";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import { invoiceSchema, projectSubscriptionUpdateInvoice } from "./stripe-invoice-observation";
import {
  validateCancellationCustomer,
  validatePeriodEndCancellationObservation,
} from "./stripe-period-end-cancellation";
import { proratedAllowanceIncrease } from "./subscription-allowance-proration";
import {
  adaptStripeSubscriptionCatalogProvider,
  getVerifiedSubscriptionPlans,
  resolveSubscriptionPlanDefinition,
  resolveSubscriptionProviderBinding,
} from "./subscription-catalog";

function reject(reason: string): never {
  throw new ElizaError("Organization upgrade requires a fresh complete provider review", {
    code: "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE",
    context: { reason },
  });
}
const cents = z.number().int().safe();
const previewTermsSchema = invoiceSchema.extend({
  id: z.string().startsWith("upcoming_in_"),
  status: z.literal("draft"),
  paid: z.literal(false),
  paid_out_of_band: z.literal(false),
  amount_paid: z.literal(0),
  charge: z.null(),
  payment_intent: z.null(),
  collection_method: z.literal("charge_automatically"),
  on_behalf_of: z.null(),
  transfer_data: z.null(),
  application_fee_amount: z.null(),
  lines: z.object({
    has_more: z.literal(false),
    data: z.array(z.object({ currency: z.literal("usd") })),
  }),
  starting_balance: cents,
  total_tax_amounts: z.array(
    z.object({ amount: cents.nonnegative(), inclusive: z.boolean(), tax_rate: z.string() }),
  ),
});

export function projectOrganizationUpgradeReview(input: {
  source: BillingSubscription;
  targetPlanKey: "plus_monthly" | "pro_monthly";
  environment: Record<string, string | undefined>;
  observedAt: Date;
  dueNow: unknown;
  recurring: unknown;
}) {
  const { source } = input;
  assertOrganizationSubscription(source);
  const previous = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version);
  const target = resolveSubscriptionPlanDefinition(input.targetPlanKey, source.catalog_version);
  const oldBinding = resolveSubscriptionProviderBinding(
    input.environment,
    source.plan_key,
    source.catalog_version,
  );
  const binding = resolveSubscriptionProviderBinding(
    input.environment,
    input.targetPlanKey,
    source.catalog_version,
  );
  const start = source.current_period_start?.getTime(),
    end = source.current_period_end?.getTime();
  const observed = input.observedAt.getTime();
  const prorationDate = Math.floor(observed / 1000);
  if (
    source.status !== "active" ||
    source.cancel_at_period_end ||
    source.pending_plan_key !== null ||
    source.ended_at !== null ||
    source.dunning_started_at !== null ||
    source.grace_expires_at !== null ||
    start === undefined ||
    end === undefined ||
    start >= end ||
    prorationDate * 1000 < start ||
    prorationDate * 1000 >= end ||
    !Number.isSafeInteger(observed) ||
    target.amountCents <= previous.amountCents ||
    binding.expectedLivemode !== (source.provider_environment === "live")
  )
    reject("source_or_target_unavailable");
  const invoice = (raw: unknown, recurring: boolean) => {
    const parsed = previewTermsSchema.safeParse(raw);
    if (!parsed.success) reject("incomplete_preview");
    const wire = parsed.data;
    const preview = projectSubscriptionUpdateInvoice({
      raw,
      livemode: binding.expectedLivemode,
      customerId: source.stripe_customer_id,
      subscriptionId: source.stripe_subscription_id,
      currency: "usd",
      prorationDate,
    });
    const lines = preview.lines;
    const tax = wire.total_tax_amounts.reduce((sum, x) => sum + x.amount, 0);
    const exclusiveTax = wire.total_tax_amounts.reduce(
      (sum, x) => sum + (x.inclusive ? 0 : x.amount),
      0,
    );
    const subtotal = lines.reduce((sum, x) => sum + x.amountCents, 0);
    if (
      !Number.isSafeInteger(tax) ||
      !Number.isSafeInteger(exclusiveTax) ||
      !Number.isSafeInteger(subtotal) ||
      subtotal !== preview.subtotalCents ||
      (wire.tax === null ? tax !== 0 : wire.tax !== tax) ||
      wire.total !== wire.subtotal - preview.discountCents + exclusiveTax ||
      !lines.every(
        (line) =>
          line.lineType === "subscription" &&
          line.subscriptionId === source.stripe_subscription_id &&
          line.subscriptionItemId === source.stripe_subscription_item_id &&
          line.quantity === 1,
      )
    )
      reject("mixed_or_inconsistent_invoice");
    if (recurring) {
      if (
        lines.length !== 1 ||
        lines[0]!.proration ||
        lines[0]!.priceId !== binding.priceId ||
        lines[0]!.amountCents !== target.amountCents ||
        lines[0]!.periodEnd <= lines[0]!.periodStart
      )
        reject("recurring_terms_changed");
    } else {
      if (
        lines.length !== 2 ||
        !lines.every(
          (line) =>
            line.proration && line.periodStart === prorationDate && line.periodEnd * 1000 === end,
        ) ||
        lines.filter((line) => line.priceId === oldBinding.priceId && line.amountCents <= 0)
          .length !== 1 ||
        lines.filter((line) => line.priceId === binding.priceId && line.amountCents >= 0).length !==
          1
      )
        reject("proration_terms_changed");
    }
    return {
      amountDueCents: preview.amountDueCents,
      subtotalCents: preview.subtotalCents,
      discountCents: preview.discountCents,
      taxCents: tax,
      totalCents: preview.totalCents,
      startingBalanceCents: wire.starting_balance,
    };
  };
  const additionalAllowanceUsd = proratedAllowanceIncrease({
    previousUsd: previous.allowance.amountUsd,
    targetUsd: target.allowance.amountUsd,
    periodStartMs: start,
    periodEndMs: end,
    effectiveAtMs: prorationDate * 1000,
  });
  return organizationUpgradeReviewSchema.parse({
    kind: "upgrade_estimate",
    subscriptionId: source.id,
    expectedSubscriptionRevision: String(source.lifecycle_revision),
    sourcePlanKey: source.plan_key,
    targetPlanKey: target.key,
    catalogVersion: source.catalog_version,
    currency: "usd",
    prorationDate,
    currentPeriodStart: new Date(start).toISOString(),
    currentPeriodEnd: new Date(end).toISOString(),
    targetBaseAmountCents: target.amountCents,
    targetAllowanceUsd: target.allowance.amountUsd,
    additionalAllowanceUsd,
    dueNow: invoice(input.dueNow, false),
    recurringEstimate: invoice(input.recurring, true),
    observedAt: input.observedAt.toISOString(),
    expiresAt: new Date(Math.min(observed + 60_000, end)).toISOString(),
  });
}

/** Identity is authenticated server context. Only a catalog plan key comes from the caller. */
export async function createOrganizationUpgradeQuote(
  input: OrganizationSubscriptionSourceInput & { targetPlanKey: "plus_monthly" | "pro_monthly" },
  revalidateSession: () => Promise<void>,
) {
  await revalidateSession();
  const captured = await readOrganizationPlanChangeSource(input);
  const source = captured.source;
  assertOrganizationSubscription(source);
  const target = resolveSubscriptionPlanDefinition(input.targetPlanKey, source.catalog_version);
  if (
    target.amountCents <=
    resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version).amountCents
  )
    reject("upgrade_target_required");
  const stripe = requireStripe(),
    environment = getCloudAwareEnv();
  await getVerifiedSubscriptionPlans({
    env: environment,
    provider: adaptStripeSubscriptionCatalogProvider(stripe),
  });
  const options = { apiVersion: GENERIC_BILLING_STRIPE_API_VERSION };
  validateCancellationCustomer({
    ...captured,
    environment,
    raw: await stripe.customers.retrieve(source.stripe_customer_id, {}, options),
  });
  const observedAt = new Date();
  validatePeriodEndCancellationObservation({
    ...captured,
    environment,
    raw: await stripe.subscriptions.retrieve(source.stripe_subscription_id, {}, options),
    observedAt,
    requireScheduled: false,
    allowRetainedCanceledAt: source.canceled_at,
  });
  const binding = resolveSubscriptionProviderBinding(
    environment,
    target.key,
    source.catalog_version,
  );
  const items = [{ id: source.stripe_subscription_item_id, price: binding.priceId, quantity: 1 }];
  const dueNow = await stripe.invoices.createPreview(
    {
      customer: source.stripe_customer_id,
      subscription: source.stripe_subscription_id,
      preview_mode: "next",
      subscription_details: {
        items,
        proration_behavior: "always_invoice",
        proration_date: Math.floor(observedAt.getTime() / 1000),
      },
    },
    options,
  );
  const recurring = await stripe.invoices.createPreview(
    {
      customer: source.stripe_customer_id,
      subscription: source.stripe_subscription_id,
      preview_mode: "recurring",
      subscription_details: { items },
    },
    options,
  );
  const review = projectOrganizationUpgradeReview({
    source,
    targetPlanKey: target.key,
    environment,
    observedAt,
    dueNow,
    recurring,
  });
  await revalidateSession();
  return saveOrganizationUpgradeQuote({ identity: input, captured, review });
}
