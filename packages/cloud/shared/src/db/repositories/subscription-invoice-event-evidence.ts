/** Receipt-owned original observations; never backfills evidence on a historical replay. */
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import { settlementDigest } from "../../lib/services/settlement-digest";
import {
  bindSubscriptionInvoiceEventEvidence,
  type SubscriptionInvoiceEventEvidence,
} from "../../lib/services/subscription-invoice-event-evidence";
import { writeTransaction } from "../helpers";
import { subscriptionInvoiceEventEvidence as evidenceTable } from "../schemas/subscription-billing-operations";
import {
  subscriptionBillingOperationsRepository as operations,
  type RecordSubscriptionEventInput,
} from "./subscription-billing-operations";

function conflict(): never {
  throw new ElizaError("Original invoice observation cannot replace or backfill a receipt", {
    code: "SUBSCRIPTION_INVOICE_EVENT_EVIDENCE_CONFLICT",
  });
}
export async function recordOriginalInvoiceEvent(
  input: RecordSubscriptionEventInput,
  observation: SubscriptionInvoiceEventEvidence,
) {
  // Validate and copy before the first await; callers cannot mutate scope while a lock is pending.
  const evidence = bindSubscriptionInvoiceEventEvidence(observation, observation.scope);
  const scope = evidence.scope;
  if (
    input.billingScope ||
    input.organizationId !== scope.organizationId ||
    input.subscriptionId !== scope.subscriptionId ||
    input.providerEventId !== scope.providerEventId ||
    input.providerObjectId !== scope.invoiceId ||
    input.providerObjectType !== "invoice" ||
    input.eventType !== evidence.event.type ||
    input.livemode !== scope.livemode ||
    input.eventCreatedAt.getTime() !== evidence.event.created * 1000
  )
    conflict();
  const request = {
    ...input,
    eventCreatedAt: new Date(input.eventCreatedAt),
    now: new Date(input.now),
  };
  return writeTransaction(async (tx) => {
    const recorded = await operations.recordEvent(request, tx);
    if (!recorded.replayed) {
      await tx
        .insert(evidenceTable)
        .values({ receipt_id: recorded.value.id, organization_id: scope.organizationId, evidence });
    } else {
      const [original] = await tx
        .select()
        .from(evidenceTable)
        .where(
          and(
            eq(evidenceTable.receipt_id, recorded.value.id),
            eq(evidenceTable.organization_id, scope.organizationId),
          ),
        )
        .limit(1);
      if (
        !original ||
        settlementDigest(bindSubscriptionInvoiceEventEvidence(original.evidence, scope)) !==
          settlementDigest(evidence)
      )
        conflict();
    }
    return recorded;
  });
}
