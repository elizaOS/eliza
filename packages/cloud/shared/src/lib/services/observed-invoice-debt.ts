/** Read-only current capture and original-debt evidence. No grant or durable publication. */
import { ElizaError } from "@elizaos/core";
import { traceOriginalInvoiceDebt } from "./original-invoice-debt-trace";
import { observeRetainedCollectingInvoiceCapture } from "./retained-collecting-invoice-capture";
import { projectRetainedInvoiceState } from "./retained-invoice-balance-observation";
import { settlementDigest } from "./settlement-digest";
import {
  bindSubscriptionInvoiceEventEvidence,
  type SubscriptionInvoiceEventEvidence,
} from "./subscription-invoice-event-evidence";

function unavailable(reason: string): never {
  throw new ElizaError("Current original invoice debt observation is unavailable", {
    code: "SUBSCRIPTION_INVOICE_DEBT_OBSERVATION_UNAVAILABLE",
    context: { reason },
  });
}
/** Caller supplies receipt-owned originals and the existing read-only absolute-deadline client.
 * Repeated reads detect changes, not an atomic provider snapshot. Original current states must
 * still match retained facts exactly; credit/void corrections need separate explicit rules.
 * Publication must recheck every implicated source fence, original and journal/receipt lease. */
export async function observeOriginalInvoiceDebt(
  input: {
    collector: SubscriptionInvoiceEventEvidence;
    originals: readonly SubscriptionInvoiceEventEvidence[];
  },
  stripe: Parameters<typeof observeRetainedCollectingInvoiceCapture>[1],
) {
  // Copy before the first await: caller-owned arrays or nested events cannot alter this attempt.
  const collector = bindSubscriptionInvoiceEventEvidence(input.collector, input.collector.scope);
  const originals = input.originals.map((value) =>
    bindSubscriptionInvoiceEventEvidence(value, value.scope),
  );
  for (const original of originals) {
    const scope = original.scope,
      owner = collector.scope;
    if (
      scope.organizationId !== owner.organizationId ||
      scope.providerAccountId !== owner.providerAccountId ||
      scope.customerId !== owner.customerId ||
      scope.livemode !== owner.livemode
    )
      unavailable("foreign_original_owner");
  }
  const before = await observeRetainedCollectingInvoiceCapture(collector, stripe);
  if (settlementDigest(before.balance.invoice) !== settlementDigest(collector.event.data.object))
    unavailable("collecting_invoice_changed");
  const trace = traceOriginalInvoiceDebt({ collector, originals, history: before.balance.history });
  const byInvoice = new Map(originals.map((original) => [original.scope.invoiceId, original]));
  async function observeComponents() {
    // Bounded parallel reads share the caller's absolute deadline; never silently omit a component.
    const result: Array<{
      invoiceId: string;
      originalEvidenceDigests: string[];
      invoice: ReturnType<typeof projectRetainedInvoiceState>;
    }> = new Array(trace.components.length);
    let next = 0;
    async function worker() {
      while (next < trace.components.length) {
        const index = next++;
        const component = trace.components[index]!;
        const original = byInvoice.get(component.invoiceId);
        if (!original) unavailable("missing_original_invoice");
        let raw: unknown;
        try {
          raw = JSON.parse(
            JSON.stringify(
              await stripe.invoices.retrieve(
                component.invoiceId,
                {},
                {
                  apiVersion: "2024-11-20.acacia",
                  maxNetworkRetries: 0,
                },
              ),
            ),
          ) as unknown;
        } catch {
          // error-policy:J1 Provider response bodies can contain private customer or credential data.
          unavailable("provider_read_failed");
        }
        const invoice = projectRetainedInvoiceState(raw, original);
        if (settlementDigest(invoice) !== settlementDigest(original.event.data.object))
          unavailable("original_invoice_changed");
        result[index] = {
          invoiceId: component.invoiceId,
          originalEvidenceDigests: [...component.originalEvidenceDigests],
          invoice,
        };
      }
    }
    // Wait for every in-flight reader before returning an error; no background work outlives this attempt.
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(4, trace.components.length) }, worker),
    );
    for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
    return result;
  }
  const first = await observeComponents(),
    second = await observeComponents();
  const after = await observeRetainedCollectingInvoiceCapture(collector, stripe);
  if (settlementDigest(first) !== settlementDigest(second) || before.digest !== after.digest)
    unavailable("debt_observation_changed");
  const body = {
    kind: "observed_original_invoice_debt" as const,
    version: 1 as const,
    organizationId: collector.scope.organizationId,
    providerAccountId: collector.scope.providerAccountId,
    customerId: collector.scope.customerId,
    livemode: collector.scope.livemode,
    collectorOriginalEvidenceDigest: collector.digest,
    originalEvidenceDigest: collector.digest,
    subscriptionId: collector.scope.subscriptionId,
    invoiceId: collector.scope.invoiceId,
    currency: collector.event.data.object.currency,
    capture: after,
    trace,
    originals: second,
  };
  return { ...body, digest: settlementDigest(body) };
}
