/** Read-only capture observation bound to a retained debt-bearing invoice, never debt allocation. */
import { ElizaError } from "@elizaos/core";
import type Stripe from "stripe";
import { z } from "zod";
import { observeRetainedInvoiceBalance } from "./retained-invoice-balance-observation";
import { settlementDigest } from "./settlement-digest";
import { validateInvoiceCapture } from "./stripe-invoice-capture";
import {
  bindSubscriptionInvoiceEventEvidence,
  type SubscriptionInvoiceEventEvidence,
} from "./subscription-invoice-event-evidence";

const options = { apiVersion: "2024-11-20.acacia", maxNetworkRetries: 0 } as const;
function unavailable(reason: string): never {
  throw new ElizaError("Retained collecting invoice capture is unavailable", {
    code: "SUBSCRIPTION_COLLECTING_CAPTURE_UNAVAILABLE",
    context: { reason },
  });
}
/** Caller supplies authenticated original evidence and the existing read-only deadline client.
 * Repeated observations detect changes, not an atomic provider snapshot. This does not infer
 * which historical debts were paid, select policy, persist results or grant allowance. */
export async function observeRetainedCollectingInvoiceCapture(
  value: SubscriptionInvoiceEventEvidence,
  stripe: Pick<Stripe, "accounts" | "invoices" | "customers" | "paymentIntents" | "charges">,
) {
  const original = bindSubscriptionInvoiceEventEvidence(value, value.scope);
  const initial = original.event.data.object;
  if (
    initial.starting_balance <= 0 ||
    initial.amount_due <= 0 ||
    !initial.payment_intent ||
    !initial.charge
  )
    unavailable("original_collecting_payment_required");
  const paymentId = initial.payment_intent,
    chargeId = initial.charge;
  async function read(operation: () => Promise<unknown>) {
    try {
      return JSON.parse(JSON.stringify(await operation())) as unknown;
    } catch {
      // error-policy:J1 Provider error bodies may contain credentials or private customer data.
      unavailable("provider_read_failed");
    }
  }
  async function snapshot() {
    // This existing observer bounds complete ledger traversal and authenticates invoice ownership.
    const balance = await observeRetainedInvoiceBalance(original, stripe);
    const rawPayment = await read(() => stripe.paymentIntents.retrieve(paymentId, {}, options));
    const rawCharge = await read(() => stripe.charges.retrieve(chargeId, {}, options));
    const capture = validateInvoiceCapture({
      invoice: balance.invoice,
      paymentIntent: rawPayment,
      charge: rawCharge,
    });
    // Current payment pointers/amounts cannot replace those in the original signed observation.
    validateInvoiceCapture({
      invoice: initial,
      paymentIntent: capture.payment,
      charge: capture.charge,
    });
    const merchant = z
      .object({ object: z.literal("account"), id: z.string() })
      .safeParse(await read(() => stripe.accounts.retrieve(null, {}, options)));
    if (!merchant.success || merchant.data.id !== original.scope.providerAccountId)
      unavailable("merchant_changed_after_capture");
    return { balance, ...capture };
  }
  const before = await snapshot(),
    after = await snapshot();
  if (settlementDigest(before) !== settlementDigest(after))
    unavailable("capture_observation_changed");
  const body = {
    kind: "retained_collecting_invoice_capture" as const,
    version: 1 as const,
    originalEvidenceDigest: original.digest,
    organizationId: original.scope.organizationId,
    subscriptionId: original.scope.subscriptionId,
    providerAccountId: original.scope.providerAccountId,
    customerId: original.scope.customerId,
    invoiceId: original.scope.invoiceId,
    livemode: original.scope.livemode,
    currency: initial.currency,
    ...after,
  };
  return { ...body, digest: settlementDigest(body) };
}
