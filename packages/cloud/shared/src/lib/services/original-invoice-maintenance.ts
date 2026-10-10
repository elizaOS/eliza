/** Bounded receipt-owned balance observations on the existing authenticated maintenance lane. */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { subscriptionBillingOperationsRepository as operations } from "../../db/repositories/subscription-billing-operations";
import {
  claimOriginalInvoiceEvent,
  listDueOriginalInvoiceEvents,
} from "../../db/repositories/subscription-invoice-event-recovery";
import { observeAndRecordOriginalInvoice } from "../../db/repositories/subscription-invoice-observations";
import { createStripeRecoveryClient } from "../stripe";

export async function recoverOriginalInvoiceObservations() {
  const deadline = Date.now() + 20_000;
  const candidates = await listDueOriginalInvoiceEvents(5);
  const attempts: Array<{
    receiptId: string;
    disposition: "recorded" | "unavailable" | "lease_lost";
  }> = [];
  let considered = 0;
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;
    considered++;
    // Corrupt original authority or database failures fail this lane; they are not empty history.
    const claim = await claimOriginalInvoiceEvent(candidate);
    if (!claim) continue;
    const identity = { ...candidate, leaseToken: claim.leaseToken };
    try {
      await observeAndRecordOriginalInvoice(identity, createStripeRecoveryClient(deadline));
      attempts.push({ receiptId: candidate.receiptId, disposition: "recorded" });
    } catch (error) {
      // error-policy:J1 Only typed unsupported/provider/stale observations become retryable evidence failures.
      // Database failures remain visible to the independent cron-lane boundary.
      if (
        !(error instanceof ElizaError) ||
        ![
          "SUBSCRIPTION_INVOICE_BALANCE_UNAVAILABLE",
          "SUBSCRIPTION_COLLECTING_CAPTURE_UNAVAILABLE",
          "SUBSCRIPTION_INVOICE_DEBT_OBSERVATION_UNAVAILABLE",
          "SUBSCRIPTION_INVOICE_DEBT_TRACE_UNAVAILABLE",
          "SUBSCRIPTION_INVOICE_DEBT_SOURCES_UNAVAILABLE",
          "SUBSCRIPTION_INVOICE_OBSERVATION_UNAVAILABLE",
          "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
        ].includes(error.code)
      )
        throw error;
      await operations.openIncident({
        organizationId: candidate.organizationId,
        subscriptionId: claim.evidence.scope.subscriptionId,
        commandId: null,
        eventReceiptId: candidate.receiptId,
        kind: "reconciliation",
        severity: "warning",
        fingerprint: createHash("sha256")
          .update(`original-invoice-observation:${candidate.organizationId}:${candidate.receiptId}`)
          .digest("hex"),
        context: {
          reason: "observation_unavailable",
          observedBy: "original_invoice_maintenance",
          receiptId: candidate.receiptId,
        },
        nextRetryAt: null,
        now: new Date(),
      });
      const released = await operations.releaseEventForRetry(identity);
      attempts.push({
        receiptId: candidate.receiptId,
        disposition: released ? "unavailable" : "lease_lost",
      });
    }
  }
  return {
    status: attempts.some((a) => a.disposition !== "recorded") ? "degraded" : "ok",
    attempts,
    deferredByBudget: candidates.length - considered,
  };
}
