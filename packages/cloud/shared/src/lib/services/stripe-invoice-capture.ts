/** Captured platform payment identity only; no invoice-balance allocation or allowance authority. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";

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

const invoiceCaptureSchema = z.object({
  object: z.literal("invoice"),
  id: z.string().regex(/^in_[A-Za-z0-9]+$/),
  customer: z.string(),
  livemode: z.boolean(),
  currency: z.literal("usd"),
  status: z.literal("paid"),
  paid: z.literal(true),
  paid_out_of_band: z.literal(false),
  amount_due: cents,
  amount_paid: cents,
  amount_remaining: z.literal(0),
  collection_method: z.literal("charge_automatically"),
  application: z.null(),
  application_fee_amount: z.null(),
  on_behalf_of: z.null(),
  transfer_data: z.null(),
  issuer: z.object({ type: z.literal("self") }),
  payment_intent: z.string().regex(/^pi_[A-Za-z0-9]+$/),
  charge: z.string().regex(/^ch_[A-Za-z0-9]+$/),
});
/** Proves matching, unrefunded platform capture for the invoice's full due amount.
 * The caller must bind invoice/merchant authority and prove invoice arithmetic, debt
 * attribution, adjustments and any allowance publication separately. A positive starting
 * balance is neither rejected nor allocated by this capture-only operation. */
export function validateInvoiceCapture(input: {
  invoice: unknown;
  paymentIntent: unknown;
  charge: unknown;
}) {
  const invoiceResult = invoiceCaptureSchema.safeParse(input.invoice);
  if (!invoiceResult.success) renewalUnavailable("unsupported_provider_shape_or_adjustment");
  const invoice = invoiceResult.data;
  const paymentResult = paymentSchema.safeParse(input.paymentIntent);
  const chargeResult = chargeSchema.safeParse(input.charge);
  if (!paymentResult.success || !chargeResult.success)
    renewalUnavailable("unsupported_provider_shape_or_adjustment");
  const payment = paymentResult.data,
    charge = chargeResult.data;
  if (
    [payment.amount, payment.amount_received, charge.amount, charge.amount_captured].some(
      (amount) => amount !== invoice.amount_due,
    ) ||
    invoice.amount_paid !== invoice.amount_due ||
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
  return { payment, charge };
}
