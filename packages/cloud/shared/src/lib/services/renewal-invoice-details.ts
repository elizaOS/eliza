/** Retains the original normalized invoice, not later provider state or adjustment policy. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import {
  createRenewalInvoiceAuthority,
  type RenewalInvoiceAuthority,
} from "./renewal-invoice-authority";
import { settlementDigest } from "./settlement-digest";
import { proveInvoiceAdjustments } from "./stripe-invoice-adjustments";
import { initialInvoiceSchema, renewalInvoiceSchema } from "./stripe-settled-invoice-schema";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const detailsSchema = z
  .object({
    kind: z.literal("renewal_invoice_details"),
    version: z.literal(1),
    authorityDigest: hash,
    invoice: z.union([renewalInvoiceSchema, initialInvoiceSchema]),
    digest: hash,
  })
  .strict();
export type RenewalInvoiceDetails = z.infer<typeof detailsSchema>;
function conflict(): never {
  throw new ElizaError("Retained invoice details do not match original grant authority", {
    code: "SUBSCRIPTION_RENEWAL_DETAILS_CONFLICT",
  });
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Call only after payment/credit settlement validation. Projection strips private provider fields.
 * This retains invoice facts; it does not retain complete payment or balance-ledger evidence. */
export function createRenewalInvoiceDetails(
  raw: unknown,
  authority: RenewalInvoiceAuthority,
): RenewalInvoiceDetails {
  const { digest, ...body } = authority;
  if (createRenewalInvoiceAuthority(body).digest !== digest) conflict();
  const parsed = z.union([renewalInvoiceSchema, initialInvoiceSchema]).safeParse(raw);
  if (!parsed.success) conflict();
  const invoice = parsed.data,
    line = invoice.lines.data[0];
  if (
    !line ||
    invoice.id !== authority.invoiceId ||
    invoice.customer !== authority.customerId ||
    invoice.subscription !== authority.providerSubscriptionId ||
    line.subscription !== invoice.subscription ||
    line.subscription_item !== authority.subscriptionItemId ||
    line.id !== authority.invoiceLineId ||
    line.price.id !== authority.priceId ||
    line.price.product !== authority.productId ||
    line.period.start !== authority.periodStart ||
    line.period.end !== authority.periodEnd ||
    invoice.livemode !== authority.livemode ||
    invoice.currency !== authority.currency ||
    invoice.total !== authority.invoiceTotal ||
    invoice.amount_paid !== authority.amountPaid ||
    invoice.amount_due !== invoice.amount_paid ||
    invoice.payment_intent !== authority.paymentIntentId ||
    invoice.charge !== authority.chargeId ||
    (proveInvoiceAdjustments(invoice, line) ?? null) !== authority.adjustmentDigest
  )
    conflict();
  const starting = BigInt(invoice.starting_balance),
    total = BigInt(invoice.total);
  const applied = -starting < total ? -starting : total;
  if (
    BigInt(invoice.ending_balance) !== starting + applied ||
    BigInt(invoice.amount_due) !== total - applied
  )
    conflict();
  // Provider order is not financial identity. Keep stable normalized arrays on replay.
  invoice.discounts.sort(compare);
  invoice.total_discount_amounts.sort((a, b) => compare(a.discount, b.discount));
  invoice.total_tax_amounts.sort((a, b) => compare(a.tax_rate, b.tax_rate));
  line.discounts.sort(compare);
  line.discount_amounts.sort((a, b) => compare(a.discount, b.discount));
  line.tax_amounts.sort((a, b) => compare(a.tax_rate, b.tax_rate));
  const retained = {
    kind: "renewal_invoice_details" as const,
    version: 1 as const,
    authorityDigest: digest,
    invoice,
  };
  return { ...retained, digest: settlementDigest(retained) };
}

/** Stored data must already be the exact private-field-free projection. Never silently
 * accept extra stored properties or attach details to another immutable grant. */
export function bindRenewalInvoiceDetails(
  value: unknown,
  authority: RenewalInvoiceAuthority,
): RenewalInvoiceDetails {
  const parsed = detailsSchema.safeParse(value);
  if (!parsed.success || parsed.data.authorityDigest !== authority.digest) conflict();
  const canonical = createRenewalInvoiceDetails(parsed.data.invoice, authority);
  if (
    parsed.data.digest !== canonical.digest ||
    settlementDigest(value) !== settlementDigest(canonical)
  )
    conflict();
  return canonical;
}
