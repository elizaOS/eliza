/** Shared original-customer invoice review for organization plan changes; no mutation authority. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import { invoiceSchema, projectSubscriptionUpdateInvoice } from "./stripe-invoice-observation";

function reject(reason: string): never {
  throw new ElizaError("Organization plan change requires a complete provider invoice review", {
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

export function projectOrganizationPlanInvoice(input: {
  raw: unknown;
  source: Pick<
    BillingSubscription,
    "stripe_customer_id" | "stripe_subscription_id" | "stripe_subscription_item_id"
  >;
  livemode: boolean;
  sourcePriceId: string;
  targetPriceId: string;
  targetAmountCents: number;
  prorationDate: number;
  periodEndMs: number;
  kind: "proration" | "recurring";
}) {
  const { raw, source, prorationDate } = input;
  const parsed = previewTermsSchema.safeParse(raw);
  if (!parsed.success) reject("incomplete_preview");
  const wire = parsed.data;
  const preview = projectSubscriptionUpdateInvoice({
    raw,
    livemode: input.livemode,
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
  if (input.kind === "recurring") {
    if (
      lines.length !== 1 ||
      lines[0]!.proration ||
      lines[0]!.priceId !== input.targetPriceId ||
      lines[0]!.amountCents !== input.targetAmountCents ||
      lines[0]!.periodEnd <= lines[0]!.periodStart
    )
      reject("recurring_terms_changed");
  } else {
    if (
      lines.length !== 2 ||
      !lines.every(
        (line) =>
          line.proration &&
          line.periodStart === prorationDate &&
          line.periodEnd * 1000 === input.periodEndMs,
      ) ||
      lines.filter((line) => line.priceId === input.sourcePriceId && line.amountCents <= 0)
        .length !== 1 ||
      lines.filter((line) => line.priceId === input.targetPriceId && line.amountCents >= 0)
        .length !== 1
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
}
