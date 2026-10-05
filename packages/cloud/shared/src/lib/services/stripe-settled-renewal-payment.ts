/** Original invoice settlement proof, independent of live subscription publication. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { proveInvoiceAdjustments } from "./stripe-invoice-adjustments";
import { proveInvoiceSettlement } from "./stripe-invoice-settlement";
import { initialInvoiceSchema, renewalInvoiceSchema } from "./stripe-settled-invoice-schema";

const cents = z.number().int().positive().safe();
const empty = z.array(z.unknown()).length(0);
export function renewalUnavailable(reason: string): never {
  throw new ElizaError("Paid renewal requires a verified current invoice and payment", {
    code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
    context: { reason },
  });
}
const paymentSchema = z.object({
  id: z.string(),
  object: z.literal("payment_intent"),
  status: z.literal("succeeded"),
  customer: z.string(),
  invoice: z.string(),
  latest_charge: z.string(),
  livemode: z.boolean(),
  currency: z.literal("usd"),
  amount: cents,
  amount_received: cents,
  amount_capturable: z.literal(0),
  application: z.null(),
  application_fee_amount: z.null(),
  on_behalf_of: z.null(),
  transfer_data: z.null(),
});
const chargeSchema = z.object({
  id: z.string(),
  object: z.literal("charge"),
  status: z.literal("succeeded"),
  customer: z.string(),
  invoice: z.string(),
  payment_intent: z.string(),
  livemode: z.boolean(),
  currency: z.literal("usd"),
  amount: cents,
  amount_captured: cents,
  amount_refunded: z.literal(0),
  captured: z.literal(true),
  paid: z.literal(true),
  refunded: z.literal(false),
  disputed: z.literal(false),
  refunds: z.object({ has_more: z.literal(false), data: empty }),
  application: z.null(),
  application_fee: z.null(),
  application_fee_amount: z.null(),
  on_behalf_of: z.null(),
  transfer: z.null().optional(),
  transfer_data: z.null(),
});
/** Proves catalog base, reconciled adjustments and captured money or explicit credit/waiver settlement. The caller must independently
 * prove retained contract authority, current ownership/lifecycle, ordered publication and leases.
 * An expired interval is valid payment evidence, never authority for current access. */
export function validateSettledRenewalPayment(input: {
  invoice: unknown;
  paymentIntent: unknown;
  charge: unknown;
  initialPayment?: boolean;
  balanceHistory?: unknown;
  expected: {
    subscriptionId: string;
    customerId: string;
    subscriptionItemId: string;
    priceId: string;
    productId: string;
    livemode: boolean;
    amountCents: number;
    start: Date;
    end: Date;
  };
}) {
  const invoiceResult = (
    input.initialPayment ? initialInvoiceSchema : renewalInvoiceSchema
  ).safeParse(input.invoice);
  const paymentResult = paymentSchema.safeParse(input.paymentIntent);
  const chargeResult = chargeSchema.safeParse(input.charge);
  if (!invoiceResult.success) renewalUnavailable("unsupported_provider_shape_or_adjustment");
  const invoice = invoiceResult.data;
  const line = invoice.lines.data[0];
  if (!line) renewalUnavailable("missing_recurring_line");
  const expected = input.expected;
  if (
    !Number.isSafeInteger(expected.amountCents) ||
    expected.amountCents <= 0 ||
    !Number.isFinite(expected.start.getTime()) ||
    !Number.isFinite(expected.end.getTime()) ||
    expected.start >= expected.end ||
    line.period.start * 1000 !== expected.start.getTime() ||
    line.period.end * 1000 !== expected.end.getTime() ||
    invoice.subscription !== expected.subscriptionId ||
    invoice.customer !== expected.customerId ||
    invoice.livemode !== expected.livemode ||
    line.subscription !== expected.subscriptionId ||
    line.subscription_item !== expected.subscriptionItemId ||
    line.price.id !== expected.priceId ||
    line.price.product !== expected.productId ||
    line.amount !== expected.amountCents
  )
    renewalUnavailable("payment_invoice_or_catalog_identity_mismatch");
  const adjustmentDigest = proveInvoiceAdjustments(invoice, line);
  const settlementDigest = proveInvoiceSettlement(invoice, input.balanceHistory);
  if (invoice.amount_due === 0) {
    if (
      invoice.payment_intent !== null ||
      invoice.charge !== null ||
      input.paymentIntent !== null ||
      input.charge !== null
    )
      renewalUnavailable("zero_due_has_payment_authority");
    return { invoice, line, payment: null, charge: null, adjustmentDigest, settlementDigest };
  }
  if (!paymentResult.success || !chargeResult.success)
    renewalUnavailable("unsupported_provider_shape_or_adjustment");
  const payment = paymentResult.data,
    charge = chargeResult.data;
  if (
    [payment.amount, payment.amount_received, charge.amount, charge.amount_captured].some(
      (amount) => amount !== invoice.amount_due,
    ) ||
    payment.id !== invoice.payment_intent ||
    payment.invoice !== invoice.id ||
    payment.customer !== invoice.customer ||
    payment.latest_charge !== invoice.charge ||
    payment.livemode !== invoice.livemode ||
    charge.id !== invoice.charge ||
    charge.invoice !== invoice.id ||
    charge.payment_intent !== payment.id ||
    charge.customer !== invoice.customer ||
    charge.livemode !== invoice.livemode
  )
    renewalUnavailable("payment_invoice_or_catalog_identity_mismatch");
  return { invoice, line, payment, charge, adjustmentDigest, settlementDigest };
}
