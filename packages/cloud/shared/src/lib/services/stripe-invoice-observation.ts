/** Shared pinned Stripe invoice wire contract for subscription adapters.
 * Callers retain ownership, catalog, mutation and journal authority. This module only
 * validates and projects provider observations; it never grants access or moves money.
 */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import type {
  BillingProviderInvoice,
  BillingProviderInvoicePreview,
} from "./generic-billing-provider-types";

const id = z.string().min(1);
const seconds = z.number().int().nonnegative().safe();
const money = z.number().int().safe();
const expandableId = z
  .union([id, z.object({ id })])
  .transform((value) => (typeof value === "string" ? value : value.id));
export const invoiceLineSchema = z.object({
  id,
  type: z.enum(["subscription", "invoiceitem"]),
  subscription: expandableId.nullable().optional(),
  subscription_item: expandableId.nullable().optional(),
  price: z.object({ id }).nullable(),
  quantity: z.number().int().nonnegative().safe().nullable(),
  amount: money,
  discount_amounts: z.array(z.object({ amount: money.nonnegative() })),
  tax_amounts: z.array(z.object({ amount: money })),
  period: z.object({ start: seconds, end: seconds }),
  proration: z.boolean(),
});
export const invoiceSchema = z.object({
  hosted_invoice_url: z.string().url().nullable(),
  id,
  object: z.literal("invoice"),
  livemode: z.boolean(),
  customer: expandableId,
  subscription: expandableId,
  charge: expandableId.nullable(),
  payment_intent: expandableId.nullable(),
  status: z.enum(["draft", "open", "paid", "uncollectible", "void"]).nullable(),
  paid: z.boolean(),
  paid_out_of_band: z.boolean(),
  amount_paid: money.nonnegative(),
  amount_due: money.nonnegative(),
  billing_reason: z.string(),
  subtotal: money,
  subtotal_excluding_tax: money.nullable(),
  total: money,
  tax: money.nullable(),
  total_discount_amounts: z.array(z.object({ amount: money.nonnegative() })),
  currency: z.string(),
  period_start: seconds,
  period_end: seconds,
});

function requireValue(condition: boolean, code: string, message: string): void {
  if (!condition) throw new ElizaError(message, { code: `BILLING_PROVIDER_${code}` });
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ElizaError("Stripe response does not satisfy the pinned Acacia billing contract", {
      code: "BILLING_PROVIDER_WIRE_SHAPE",
    });
  return result.data;
}
export function projectInvoiceLine(
  line: z.infer<typeof invoiceLineSchema>,
): BillingProviderInvoice["lines"][number] {
  return {
    lineId: line.id,
    lineType: line.type,
    subscriptionId: line.subscription ?? null,
    subscriptionItemId: line.subscription_item ?? null,
    priceId: line.price?.id ?? null,
    discountAmountsCents: line.discount_amounts.map((entry) => entry.amount),
    taxAmountsCents: line.tax_amounts.map((entry) => entry.amount),
    quantity: line.quantity,
    amountCents: line.amount,
    periodStart: line.period.start,
    periodEnd: line.period.end,
    proration: line.proration,
  };
}

/** Validates a complete quote against the server-captured customer and subscription. */
export function projectSubscriptionUpdateInvoice(input: {
  raw: unknown;
  livemode: boolean;
  customerId: string;
  subscriptionId: string;
  currency: string;
  prorationDate: number;
}): BillingProviderInvoicePreview {
  const raw = input.raw;
  const value = parse(
    invoiceSchema.extend({
      automatic_tax: z.object({ enabled: z.boolean(), status: z.string().nullable() }),
      lines: z.object({ has_more: z.boolean(), data: z.array(invoiceLineSchema) }),
    }),
    raw,
  );
  requireValue(
    value.livemode === input.livemode &&
      value.customer === input.customerId &&
      value.subscription === input.subscriptionId &&
      value.currency === input.currency,
    "PREVIEW_SCOPE",
    "Invoice preview differs from the stored customer, subscription or merchant",
  );
  requireValue(
    !value.lines.has_more,
    "PREVIEW_INCOMPLETE",
    "Provider preview contains additional lines; a complete review is required before confirmation",
  );
  requireValue(
    !value.automatic_tax.enabled || value.automatic_tax.status === "complete",
    "PREVIEW_TAX",
    "Invoice tax calculation is incomplete; update billing address and review again",
  );
  requireValue(
    value.lines.data.every(
      (line) => !line.subscription || line.subscription === input.subscriptionId,
    ),
    "INVOICE_LINE_SCOPE",
    "Preview includes a line from another subscription",
  );
  return {
    currency: value.currency,
    amountDueCents: value.amount_due,
    subtotalCents: value.subtotal,
    totalCents: value.total,
    taxCents: value.tax,
    discountCents: parse(
      money.nonnegative(),
      value.total_discount_amounts.reduce((sum, entry) => sum + entry.amount, 0),
    ),
    prorationCents: parse(
      money,
      value.lines.data
        .filter((line) => line.proration && line.period.start === input.prorationDate)
        .reduce((sum, line) => sum + line.amount, 0),
    ),
    lines: value.lines.data.map(projectInvoiceLine),
  };
}
