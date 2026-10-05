/** Observation labels only. Only the paid finalizer may publish subscription authority. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { invoiceSchema } from "./stripe-invoice-observation";

const observation = invoiceSchema.extend({
  amount_remaining: z.number().int().nonnegative().safe(),
});
export function observeOriginalUpgradeInvoiceState(input: {
  raw: unknown;
  invoiceId: string;
  customerId: string;
  subscriptionId: string;
  livemode: boolean;
}) {
  const parsed = observation.safeParse(input.raw);
  if (!parsed.success)
    throw new ElizaError("Upgrade invoice observation is incomplete", {
      code: "SUBSCRIPTION_UPGRADE_INVOICE_RECOVERY_UNAVAILABLE",
    });
  const invoice = parsed.data;
  if (
    invoice.id !== input.invoiceId ||
    invoice.customer !== input.customerId ||
    invoice.subscription !== input.subscriptionId ||
    invoice.livemode !== input.livemode ||
    invoice.billing_reason !== "subscription_update" ||
    invoice.currency !== "usd" ||
    invoice.paid_out_of_band
  )
    throw new ElizaError("Upgrade invoice identity or payment channel changed", {
      code: "SUBSCRIPTION_UPGRADE_INVOICE_RECOVERY_UNAVAILABLE",
    });
  if (invoice.status === "paid" && invoice.paid && invoice.amount_remaining === 0)
    return "paid_candidate" as const;
  if (
    invoice.status === "open" &&
    !invoice.paid &&
    invoice.amount_remaining > 0 &&
    invoice.amount_paid === 0
  )
    return "awaiting_payment" as const;
  if (invoice.status === "void" && !invoice.paid && invoice.amount_paid === 0)
    return "void_candidate" as const;
  // Uncollectible/draft/contradictory flags require broader target and event
  // reconciliation; none alone proves it is safe to admit another provider write.
  return "requires_reconciliation" as const;
}
