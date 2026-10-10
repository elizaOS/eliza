/** Original invoice settlement proof, independent of live subscription publication. */
import { renewalUnavailable, validateInvoiceCapture } from "./stripe-invoice-capture";

export { renewalUnavailable } from "./stripe-invoice-capture";

import { proveInvoiceAdjustments } from "./stripe-invoice-adjustments";
import { proveInvoiceSettlement } from "./stripe-invoice-settlement";
import { initialInvoiceSchema, renewalInvoiceSchema } from "./stripe-settled-invoice-schema";

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
  const { payment, charge } = validateInvoiceCapture(input);
  return { invoice, line, payment, charge, adjustmentDigest, settlementDigest };
}
