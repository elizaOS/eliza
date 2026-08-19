/**
 * Projects settled provider payments into tenant-bound purchase receipts.
 * Exact retries return the existing row; any changed settlement authority fails.
 */
import { ElizaError } from "@elizaos/core";
import { and, eq, or } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import {
  type PaymentRequestReceipt,
  paymentRequestReceipts,
} from "../../db/schemas/payment-request-receipts";

export interface ProjectPaymentRequestReceiptInput {
  organizationId: string;
  paymentRequestId: string;
  provider: "stripe" | "oxapay";
  providerTxRef: string;
  providerEventId: string;
  amountCents: number;
  currency: string;
  settledAt: Date;
  payloadDigest: string;
  settlementProof: Record<string, unknown>;
}

export class PaymentRequestReceiptConflictError extends ElizaError {
  override readonly name = "PaymentRequestReceiptConflictError";

  constructor(message: string) {
    super(message, {
      code: "PAYMENT_REQUEST_RECEIPT_CONFLICT",
      severity: "fatal",
    });
  }
}

export async function projectPaymentRequestReceipt(
  tx: DbTransaction,
  input: ProjectPaymentRequestReceiptInput,
): Promise<PaymentRequestReceipt> {
  const amountCents = BigInt(input.amountCents);
  const [inserted] = await tx
    .insert(paymentRequestReceipts)
    .values({
      organization_id: input.organizationId,
      payment_request_id: input.paymentRequestId,
      receipt_type: "provider_payment_receipt",
      provider: input.provider,
      provider_tx_ref: input.providerTxRef,
      provider_event_id: input.providerEventId,
      amount_cents: amountCents,
      currency: input.currency,
      settled_at: input.settledAt,
      payload_digest: input.payloadDigest,
      settlement_proof: input.settlementProof,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;

  const [exactReplay] = await tx
    .select()
    .from(paymentRequestReceipts)
    .where(
      and(
        eq(paymentRequestReceipts.organization_id, input.organizationId),
        eq(paymentRequestReceipts.payment_request_id, input.paymentRequestId),
        eq(paymentRequestReceipts.receipt_type, "provider_payment_receipt"),
        eq(paymentRequestReceipts.provider, input.provider),
        eq(paymentRequestReceipts.provider_tx_ref, input.providerTxRef),
        eq(paymentRequestReceipts.provider_event_id, input.providerEventId),
        eq(paymentRequestReceipts.amount_cents, amountCents),
        eq(paymentRequestReceipts.currency, input.currency),
        eq(paymentRequestReceipts.settled_at, input.settledAt),
        eq(paymentRequestReceipts.payload_digest, input.payloadDigest),
        eq(paymentRequestReceipts.settlement_proof, input.settlementProof),
      ),
    )
    .limit(1);
  if (exactReplay) return exactReplay;

  const [conflictingReceipt] = await tx
    .select({ id: paymentRequestReceipts.id })
    .from(paymentRequestReceipts)
    .where(
      or(
        eq(paymentRequestReceipts.payment_request_id, input.paymentRequestId),
        and(
          eq(paymentRequestReceipts.provider, input.provider),
          eq(paymentRequestReceipts.provider_tx_ref, input.providerTxRef),
        ),
      ),
    )
    .limit(1);
  throw new PaymentRequestReceiptConflictError(
    conflictingReceipt
      ? "Payment receipt replay conflicts with immutable settlement metadata"
      : "Payment receipt insert conflicted without a matching settlement authority",
  );
}
