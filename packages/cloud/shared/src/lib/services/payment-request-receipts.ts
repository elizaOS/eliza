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

const SETTLEMENT_PROOF_FIELDS = {
  stripe: [
    "stripe_event_id",
    "stripe_event_type",
    "stripe_session_id",
    "stripe_payment_intent_id",
    "stripe_amount_total",
    "stripe_currency",
    "stripe_payment_status",
  ],
  oxapay: [
    "provider",
    "oxapay_track_id",
    "oxapay_order_id",
    "oxapay_status",
    "oxapay_amount_cents",
    "oxapay_currency",
  ],
} as const satisfies Record<"stripe" | "oxapay", readonly string[]>;

/** Retains only provider-defined scalar fields that are safe for durable settlement records. */
export function curatePaymentRequestSettlementProof(
  provider: "stripe" | "oxapay",
  proof: Record<string, unknown>,
): Record<string, string | number | null> {
  const curated: Record<string, string | number | null> = {};
  for (const field of SETTLEMENT_PROOF_FIELDS[provider]) {
    const value = proof[field];
    if (
      value === null ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      curated[field] = value;
    }
  }
  return curated;
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
  const currency = input.currency.trim().toUpperCase();
  const settlementProof = curatePaymentRequestSettlementProof(
    input.provider,
    input.settlementProof,
  );
  if (
    (input.provider === "stripe" &&
      (settlementProof.stripe_event_id !== input.providerEventId ||
        settlementProof.stripe_event_type !== "checkout.session.completed" ||
        settlementProof.stripe_payment_intent_id !== input.providerTxRef ||
        settlementProof.stripe_amount_total !== input.amountCents ||
        typeof settlementProof.stripe_currency !== "string" ||
        settlementProof.stripe_currency.trim().toUpperCase() !== currency ||
        settlementProof.stripe_payment_status !== "paid" ||
        typeof settlementProof.stripe_session_id !== "string" ||
        !settlementProof.stripe_session_id.trim())) ||
    (input.provider === "oxapay" &&
      (settlementProof.provider !== input.provider ||
        settlementProof.oxapay_track_id !== input.providerTxRef ||
        settlementProof.oxapay_order_id !== input.paymentRequestId ||
        settlementProof.oxapay_status !== "paid" ||
        settlementProof.oxapay_amount_cents !== input.amountCents ||
        typeof settlementProof.oxapay_currency !== "string" ||
        settlementProof.oxapay_currency.trim().toUpperCase() !== currency))
  ) {
    throw new PaymentRequestReceiptConflictError(
      "Payment receipt proof does not match provider settlement authority",
    );
  }
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
      currency,
      settled_at: input.settledAt,
      payload_digest: input.payloadDigest,
      settlement_proof: settlementProof,
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
        eq(paymentRequestReceipts.currency, currency),
        eq(paymentRequestReceipts.settled_at, input.settledAt),
        eq(paymentRequestReceipts.payload_digest, input.payloadDigest),
        eq(paymentRequestReceipts.settlement_proof, settlementProof),
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
