/** Failed target invoices establish dunning only; captured payment remains separate renewal authority. */
import { z } from "zod";
import {
  observeScheduledTargetLiveSubscription,
  observeScheduledTargetSubscription,
} from "./organization-schedule-target-observation";
import { renewalUnavailable } from "./stripe-paid-renewal-validation";

export interface ScheduledDunningObjects {
  subscription: unknown;
  customer: unknown;
  schedule: unknown;
  invoice: unknown;
}
const seconds = z.number().int().nonnegative().safe();
export const failedRenewalInvoiceSchema = z.object({
  id: z.string().regex(/^in_[A-Za-z0-9]+$/),
  object: z.literal("invoice"),
  subscription: z.string(),
  customer: z.string(),
  livemode: z.boolean(),
  billing_reason: z.literal("subscription_cycle"),
  status: z.enum(["open", "uncollectible"]),
  paid: z.literal(false),
  paid_out_of_band: z.literal(false),
  collection_method: z.literal("charge_automatically"),
  currency: z.literal("usd"),
  amount_due: z.number().int().positive().safe(),
  amount_remaining: z.number().int().positive().safe(),
  application: z.null(),
  on_behalf_of: z.null(),
  transfer_data: z.null(),
  issuer: z.object({ type: z.literal("self") }),
  lines: z.object({
    has_more: z.literal(false),
    data: z
      .array(
        z.object({
          type: z.literal("subscription"),
          subscription: z.string(),
          subscription_item: z.string(),
          quantity: z.literal(1),
          proration: z.literal(false),
          currency: z.literal("usd"),
          period: z.object({ start: seconds, end: seconds }),
          price: z.object({ id: z.string(), product: z.string() }),
        }),
      )
      .length(1),
  }),
});
export function validateScheduledDunningObjects(
  input: Omit<
    Parameters<typeof observeScheduledTargetSubscription>[0],
    "rawSubscription" | "rawCustomer" | "invoiceId"
  > & { objects: ScheduledDunningObjects },
) {
  const { source, authority, objects } = input;
  const invoice = failedRenewalInvoiceSchema.safeParse(objects.invoice);
  const status = z
    .object({ status: z.enum(["past_due", "unpaid"]) })
    .safeParse(objects.subscription);
  if (!invoice.success || !status.success)
    renewalUnavailable("scheduled_dunning_objects_unverified");
  const value = invoice.data,
    line = value.lines.data[0]!;
  const historical = authority.phase.end <= input.observedAt;
  const observe = historical
    ? observeScheduledTargetLiveSubscription
    : observeScheduledTargetSubscription;
  const observation = observe(
    {
      ...input,
      rawSubscription: objects.subscription,
      rawCustomer: objects.customer,
      invoiceId: value.id,
    },
    status.data.status,
  );
  if (
    value.subscription !== source.stripe_subscription_id ||
    value.customer !== source.stripe_customer_id ||
    value.livemode !== authority.binding.livemode ||
    value.amount_remaining > value.amount_due ||
    line.subscription !== source.stripe_subscription_id ||
    (historical
      ? !/^si_[A-Za-z0-9]+$/.test(line.subscription_item) || value.id === observation.invoiceId
      : line.subscription_item !== observation.subscriptionItemId) ||
    line.price.id !== authority.binding.targetPriceId ||
    line.price.product !== authority.binding.targetProductId ||
    line.period.start * 1000 !== authority.phase.start.getTime() ||
    line.period.end * 1000 !== authority.phase.end.getTime()
  )
    renewalUnavailable("scheduled_dunning_invoice_identity_mismatch");
  return {
    providerStatus: status.data.status,
    providerObjectDigest: observation.providerObjectDigest,
    invoiceId: value.id,
  };
}
