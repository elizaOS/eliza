/** Pinned subscription terms that must survive schedule attachment and phase replacement. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { settlementDigest } from "./settlement-digest";
import { organizationSubscriptionObservationSchema } from "./stripe-organization-subscription-observation";

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`));
const seconds = z.number().int().nonnegative().safe();
const metadata = z.record(z.string(), z.string());
const reference = (prefix: string) =>
  z.union([
    id(prefix),
    z.object({ id: id(prefix), deleted: z.literal(false).optional() }).transform((v) => v.id),
  ]);
const taxRates = z
  .array(reference("txr"))
  .nullable()
  .optional()
  .transform((v) => v ?? []);
const discountRefs = z.array(reference("di"));
const thresholds = z
  .object({
    amount_gte: z.number().int().positive().safe().nullable(),
    reset_billing_cycle_anchor: z.boolean().nullable(),
  })
  .strict()
  .nullable();
const self = z.object({ type: z.literal("self") }).strict();
const sourceItem = organizationSubscriptionObservationSchema.shape.items.shape.data.element.extend({
  id: id("si"),
  price:
    organizationSubscriptionObservationSchema.shape.items.shape.data.element.shape.price.extend({
      tax_behavior: z.enum(["inclusive", "exclusive", "unspecified"]),
    }),
  billing_thresholds: z
    .object({ usage_gte: z.number().int().positive().safe().nullable() })
    .strict()
    .nullable(),
  discounts: discountRefs,
  tax_rates: taxRates,
  metadata,
});
export const organizationScheduleRetainedSubscriptionSchema =
  organizationSubscriptionObservationSchema.extend({
    id: id("sub"),
    customer: id("cus"),
    application: z.null(),
    currency: z.literal("usd"),
    collection_method: z.literal("charge_automatically"),
    days_until_due: z.null(),
    automatic_tax: z.object({ enabled: z.boolean(), liability: self.nullable() }).strict(),
    billing_cycle_anchor: seconds,
    billing_cycle_anchor_config: z
      .object({
        day_of_month: z.number().int().min(1).max(31),
        hour: z.number().int().min(0).max(23).nullable(),
        minute: z.number().int().min(0).max(59).nullable(),
        second: z.number().int().min(0).max(59).nullable(),
        month: z.number().int().min(1).max(12).nullable(),
      })
      .strict()
      .nullable(),
    billing_thresholds: thresholds,
    default_payment_method: reference("pm").nullable(),
    // Legacy sources cannot be represented in the pinned phase update request.
    default_source: z.null(),
    default_tax_rates: taxRates,
    description: z.string().nullable(),
    discount: reference("di").nullable(),
    discounts: discountRefs,
    invoice_settings: z
      .object({
        account_tax_ids: z.array(reference("txi")).nullable(),
        issuer: self,
      })
      .strict(),
    metadata,
    next_pending_invoice_item_invoice: z.null(),
    pending_invoice_item_interval: z.null(),
    pending_setup_intent: z.null(),
    // Non-default mandates/payment options need dedicated schedule qualification.
    payment_settings: z
      .object({
        payment_method_options: z.null(),
        payment_method_types: z.null(),
        save_default_payment_method: z.enum(["off", "on_subscription"]),
      })
      .strict()
      .nullable(),
    items: z.object({ has_more: z.literal(false), data: z.array(sourceItem).length(1) }),
  });
function reject(reason: string): never {
  throw new ElizaError("Schedule requires complete supported retained billing terms", {
    code: "SUBSCRIPTION_PLAN_CHANGE_REOBSERVE",
    context: { reason },
  });
}
/** Pure preflight, before any create effect. Identity/catalog authorization is also required.
 * Reject unsupported settings rather than erase them while mapping a phase. This digest
 * must be bound to durable original effect authority before it authorizes provider I/O.
 */
export function observeOrganizationScheduleRetainedTerms(input: {
  raw: unknown;
  observedAt: Date;
}) {
  const parsed = organizationScheduleRetainedSubscriptionSchema.safeParse(input.raw);
  if (!parsed.success) reject("unsupported_retained_settings");
  const source = parsed.data;
  const observed = input.observedAt.getTime();
  if (
    !Number.isSafeInteger(observed) ||
    source.current_period_start * 1000 > observed ||
    source.current_period_end * 1000 <= observed ||
    source.items.data[0]!.price.livemode !== source.livemode ||
    source.cancel_at_period_end ||
    source.cancel_at !== null ||
    (source.trial_end !== null && source.trial_end * 1000 > observed) ||
    (source.discount !== null && !source.discounts.includes(source.discount)) ||
    new Set(source.discounts).size !== source.discounts.length ||
    new Set(source.items.data[0]!.discounts).size !== source.items.data[0]!.discounts.length
  )
    reject("retained_settings_changed_or_inconsistent");
  const item = source.items.data[0]!;
  const retained = {
    automaticTax: source.automatic_tax,
    billingCycleAnchor: source.billing_cycle_anchor,
    billingCycleAnchorConfig: source.billing_cycle_anchor_config,
    billingThresholds: source.billing_thresholds,
    collectionMethod: source.collection_method,
    defaultPaymentMethod: source.default_payment_method,
    defaultTaxRates: source.default_tax_rates,
    description: source.description,
    discounts: source.discounts,
    invoiceSettings: source.invoice_settings,
    metadata: source.metadata,
    paymentSettings: source.payment_settings,
    trialStart: source.trial_start,
    trialEnd: source.trial_end,
    item: {
      billingThresholds: item.billing_thresholds,
      discounts: item.discounts,
      taxRates: item.tax_rates,
      metadata: item.metadata,
      quantity: item.quantity,
    },
  };
  const identity = {
    subscriptionId: source.id,
    customerId: source.customer,
    livemode: source.livemode,
    itemId: item.id,
    priceId: item.price.id,
    productId: item.price.product,
    sourceUnitAmountCents: item.price.unit_amount,
    taxBehavior: item.price.tax_behavior,
    periodStart: source.current_period_start,
    periodEnd: source.current_period_end,
  };
  return {
    version: 1 as const,
    identity,
    retained,
    digest: settlementDigest({ version: 1, identity, retained }),
  };
}
