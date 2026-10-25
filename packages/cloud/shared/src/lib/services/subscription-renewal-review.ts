/** Read-only, short-lived renewal estimates for undoing an organization cancellation.
 * A preview is not a price lock, mutation authorization, invoice or payment receipt.
 */
import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { z } from "zod";
import {
  type PrepareCancellationInput,
  readCancellationUndoReviewSource,
} from "../../db/repositories/subscription-cancellation";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import { requireStripe } from "../stripe";
import {
  type ConfiguredCancellationAuthority,
  configuredCancellationRequest,
  observeConfiguredCancellation,
} from "./configured-schedule-cancellation";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import {
  cancellationReobserve,
  validateCancellationCustomer,
  validatePeriodEndCancellationObservation,
} from "./stripe-period-end-cancellation";
import {
  resolveSubscriptionPlanDefinition,
  resolveSubscriptionProviderBinding,
} from "./subscription-catalog";
import { retrieveSubscriptionLifecycleBinding } from "./subscription-lifecycle-provider-binding";
import type { SubscriptionRenewalReview } from "./subscription-renewal-review-contract";

const cents = z.number().int().safe();
const seconds = z.number().int().positive().max(8_640_000_000_000).safe();
// This is the response contract of the pinned 2024-11-20.acacia provider API.
const previewSchema = z.object({
  id: z.string().startsWith("upcoming_in_"),
  object: z.literal("invoice"),
  status: z.literal("draft"),
  livemode: z.boolean(),
  customer: z.string(),
  subscription: z.string(),
  currency: z.literal("usd"),
  collection_method: z.literal("charge_automatically"),
  on_behalf_of: z.null(),
  transfer_data: z.null(),
  application_fee_amount: z.null(),
  automatic_tax: z.object({ enabled: z.boolean(), status: z.string().nullable() }),
  amount_due: cents.nonnegative(),
  subtotal: cents.nonnegative(),
  total: cents.nonnegative(),
  tax: cents.nonnegative().nullable(),
  starting_balance: cents,
  total_discount_amounts: z.array(z.object({ amount: cents.nonnegative(), discount: z.string() })),
  total_tax_amounts: z.array(
    z.object({ amount: cents.nonnegative(), inclusive: z.boolean(), tax_rate: z.string() }),
  ),
  lines: z.object({
    has_more: z.literal(false),
    data: z
      .array(
        z.object({
          type: z.literal("subscription"),
          subscription: z.string(),
          subscription_item: z.string(),
          proration: z.literal(false),
          currency: z.literal("usd"),
          quantity: z.literal(1),
          amount: cents.nonnegative(),
          price: z.object({ id: z.string() }),
          period: z.object({ start: seconds, end: seconds }),
        }),
      )
      .length(1),
  }),
});

/** Rejects incomplete or mixed-scope previews rather than inventing missing totals. */
export function projectSubscriptionRenewalReview(input: {
  source: BillingSubscription;
  raw: unknown;
  environment: Record<string, string | undefined>;
  observedAt: Date;
}): SubscriptionRenewalReview {
  const { source } = input;
  assertOrganizationSubscription(source);
  const parsed = previewSchema.safeParse(input.raw);
  if (!parsed.success) cancellationReobserve("renewal_preview_unsupported");
  const invoice = parsed.data;
  const line = invoice.lines.data[0]!;
  const plan = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version);
  const binding = resolveSubscriptionProviderBinding(
    input.environment,
    source.plan_key,
    source.catalog_version,
  );
  const tax = invoice.total_tax_amounts.reduce((total, item) => total + item.amount, 0);
  const discount = invoice.total_discount_amounts.reduce((total, item) => total + item.amount, 0);
  const exclusiveTax = invoice.total_tax_amounts.reduce(
    (total, item) => total + (item.inclusive ? 0 : item.amount),
    0,
  );
  if (
    !Number.isSafeInteger(input.observedAt.getTime()) ||
    source.status !== "active" ||
    !source.cancel_at_period_end ||
    !Number.isSafeInteger(source.lifecycle_revision) ||
    source.lifecycle_revision <= 0 ||
    source.current_period_end === null ||
    source.current_period_end <= input.observedAt ||
    invoice.customer !== source.stripe_customer_id ||
    invoice.subscription !== source.stripe_subscription_id ||
    invoice.livemode !== (source.provider_environment === "live") ||
    invoice.livemode !== binding.expectedLivemode ||
    line.subscription !== source.stripe_subscription_id ||
    line.subscription_item !== source.stripe_subscription_item_id ||
    line.price.id !== binding.priceId ||
    line.amount !== plan.amountCents ||
    line.period.start * 1000 !== source.current_period_end.getTime() ||
    line.period.end <= line.period.start ||
    !Number.isSafeInteger(line.period.end * 1000) ||
    (invoice.automatic_tax.enabled && invoice.automatic_tax.status !== "complete") ||
    invoice.subtotal !== line.amount ||
    discount > invoice.subtotal ||
    invoice.total !== invoice.subtotal - discount + exclusiveTax ||
    !Number.isSafeInteger(tax) ||
    !Number.isSafeInteger(discount) ||
    (invoice.tax === null ? tax !== 0 : invoice.tax !== tax)
  )
    cancellationReobserve("renewal_preview_identity_period_or_tax_changed");
  const terms = {
    subscriptionId: source.id,
    expectedSubscriptionRevision: String(source.lifecycle_revision),
    planKey: source.plan_key,
    catalogVersion: source.catalog_version,
    currency: invoice.currency,
    interval: plan.interval,
    intervalCount: plan.intervalCount,
    baseAmountCents: plan.amountCents,
    renewalAt: source.current_period_end.toISOString(),
    nextPeriodEnd: new Date(line.period.end * 1000).toISOString(),
    subtotalCents: invoice.subtotal,
    discountCents: discount,
    taxCents: tax,
    totalCents: invoice.total,
    startingBalanceCents: invoice.starting_balance,
    amountDueCents: invoice.amount_due,
  };
  return {
    ...terms,
    kind: "renewal_estimate" as const,
    observedAt: input.observedAt.toISOString(),
    expiresAt: new Date(
      Math.min(input.observedAt.getTime() + 60_000, source.current_period_end.getTime()),
    ).toISOString(),
    // A comparison fingerprint, not an authorization token. Provider identifiers remain private.
    termsDigest: createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          organizationId: source.organization_id,
          providerEnvironment: source.provider_environment,
          customer: source.stripe_customer_id,
          subscription: source.stripe_subscription_id,
          terms,
          taxes: invoice.total_tax_amounts,
          discounts: invoice.total_discount_amounts,
        }),
      )
      .digest("hex"),
  };
}

export async function readOrganizationSubscriptionRenewalReview(
  input: Omit<PrepareCancellationInput, "idempotencyKey">,
  revalidateSession: () => Promise<void>,
) {
  await revalidateSession();
  const captured = await readCancellationUndoReviewSource(input);
  const review = await previewSubscriptionRenewalTerms(captured);
  await revalidateSession();
  const current = await readCancellationUndoReviewSource(input);
  if (
    JSON.stringify(current) !== JSON.stringify(captured) ||
    Date.now() >= Date.parse(review.expiresAt)
  )
    cancellationReobserve("renewal_review_expired_or_source_changed");
  return review;
}

/** Also used inside a claimed command; primary command authority is fenced by its caller. */
export async function previewSubscriptionRenewalTerms(captured: {
  source: BillingSubscription;
  organizationCustomerId: string | null;
  configuredCancellation?: ConfiguredCancellationAuthority | null;
}): Promise<SubscriptionRenewalReview> {
  const stripe = requireStripe();
  const { environment } = await retrieveSubscriptionLifecycleBinding(captured.source, stripe);
  const startedAt = new Date();
  const customer = await stripe.customers.retrieve(captured.source.stripe_customer_id);
  validateCancellationCustomer({ ...captured, environment, raw: customer });
  const raw = await stripe.subscriptions.retrieve(captured.source.stripe_subscription_id);
  if (captured.configuredCancellation) {
    const observed = observeConfiguredCancellation({
      authority: captured.configuredCancellation,
      source: captured.source,
      rawSubscription: raw,
      rawSchedule: await stripe.subscriptionSchedules.retrieve(
        captured.configuredCancellation.scheduleId,
      ),
      observedAt: startedAt,
    });
    if (!observed.scheduled) cancellationReobserve("configured_cancellation_not_scheduled");
  } else
    validatePeriodEndCancellationObservation({
      ...captured,
      environment,
      raw,
      observedAt: startedAt,
      requireScheduled: true,
    });
  const preview = await stripe.invoices.createPreview(
    captured.configuredCancellation
      ? {
          customer: captured.source.stripe_customer_id,
          schedule: captured.configuredCancellation.scheduleId,
          preview_mode: "next",
          schedule_details: configuredCancellationRequest(
            captured.configuredCancellation,
            false,
          ) as unknown as Stripe.InvoiceCreatePreviewParams.ScheduleDetails,
        }
      : {
          customer: captured.source.stripe_customer_id,
          subscription: captured.source.stripe_subscription_id,
          preview_mode: "next",
          subscription_details: { cancel_at_period_end: false, proration_behavior: "none" },
        },
  );
  return projectSubscriptionRenewalReview({
    source: captured.source,
    raw: preview,
    environment,
    observedAt: startedAt,
  });
}
