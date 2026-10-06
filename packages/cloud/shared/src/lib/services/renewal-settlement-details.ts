/** Original normalized settlement inputs, retained with the existing grant, never current payment health. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import type { RenewalInvoiceAuthority } from "./renewal-invoice-authority";
import { bindRenewalInvoiceDetails, type RenewalInvoiceDetails } from "./renewal-invoice-details";
import { settlementDigest } from "./settlement-digest";
import { invoiceBalanceHistorySchema } from "./stripe-invoice-settlement";
import { validateSettledRenewalPayment } from "./stripe-settled-renewal-payment";

const stored = z
  .object({
    kind: z.literal("renewal_settlement_details"),
    version: z.literal(1),
    invoiceDetailsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    payment: z.unknown(),
    charge: z.unknown(),
    balanceHistory: z.unknown(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
function conflict(): never {
  throw new ElizaError("Retained settlement details conflict with original invoice authority", {
    code: "SUBSCRIPTION_SETTLEMENT_DETAILS_CONFLICT",
  });
}
export function createRenewalSettlementDetails(
  input: { payment: unknown; charge: unknown; balanceHistory?: unknown },
  invoiceDetails: RenewalInvoiceDetails,
  authority: RenewalInvoiceAuthority,
) {
  const details = bindRenewalInvoiceDetails(invoiceDetails, authority);
  const invoice = details.invoice,
    line = invoice.lines.data[0]!;
  // Only credit-bearing invoices require complete customer history. Do not retain unrelated data.
  const history =
    invoice.starting_balance < 0
      ? invoiceBalanceHistorySchema.safeParse(input.balanceHistory)
      : null;
  if (history && !history.success) conflict();
  const balanceHistory = history?.success ? history.data : null;
  const proof = validateSettledRenewalPayment({
    invoice,
    paymentIntent: input.payment,
    charge: input.charge,
    balanceHistory,
    initialPayment: invoice.billing_reason === "subscription_create",
    expected: {
      subscriptionId: authority.providerSubscriptionId,
      customerId: authority.customerId,
      subscriptionItemId: authority.subscriptionItemId,
      priceId: authority.priceId,
      productId: authority.productId,
      livemode: authority.livemode,
      amountCents: line.amount,
      start: new Date(authority.periodStart * 1000),
      end: new Date(authority.periodEnd * 1000),
    },
  });
  if (
    (proof.settlementDigest ?? null) !== authority.settlementDigest ||
    (proof.adjustmentDigest ?? null) !== authority.adjustmentDigest
  )
    conflict();
  const body = {
    kind: "renewal_settlement_details" as const,
    version: 1 as const,
    invoiceDetailsDigest: details.digest,
    payment: proof.payment,
    charge: proof.charge,
    balanceHistory,
  };
  return { ...body, digest: settlementDigest(body) };
}
export type RenewalSettlementDetails = ReturnType<typeof createRenewalSettlementDetails>;
export function bindRenewalSettlementDetails(
  value: unknown,
  invoiceDetails: RenewalInvoiceDetails,
  authority: RenewalInvoiceAuthority,
): RenewalSettlementDetails {
  const parsed = stored.safeParse(value);
  if (!parsed.success || parsed.data.invoiceDetailsDigest !== invoiceDetails.digest) conflict();
  const canonical = createRenewalSettlementDetails(parsed.data, invoiceDetails, authority);
  if (
    parsed.data.digest !== canonical.digest ||
    settlementDigest(value) !== settlementDigest(canonical)
  )
    conflict();
  return canonical;
}
