/**
 * Atomically binds provider webhooks to payment requests and fulfills their
 * organization-credit purchase. The durable webhook row is also the callback
 * outbox; process-local listeners never decide whether money was fulfilled.
 */
import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import { and, asc, eq, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { dbWrite, writeTransaction } from "../../db/helpers";
import {
  MAX_PAYMENT_REQUEST_LEDGER_CENTS,
  type PaymentCallbackState,
  type PaymentProviderEventDisposition,
  type PaymentRequestProvider,
  paymentRequestEvents,
  paymentRequests,
} from "../../db/schemas/payment-requests";
import { safeFetch } from "../security/safe-fetch";
import { logger } from "../utils/logger";
import { creditsService } from "./credits";
import {
  curatePaymentRequestSettlementProof,
  projectPaymentRequestReceipt,
} from "./payment-request-receipts";

const MAX_CALLBACK_ATTEMPTS = 12;

/** Formats integer cents without crossing a binary floating-point money boundary. */
export function formatUsdFromCents(amountCents: number): string {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new PaymentProviderEventConflictError("Credit amount cents must be a safe integer");
  }
  const whole = Math.floor(amountCents / 100);
  const fraction = amountCents % 100;
  return `${whole}.${String(fraction).padStart(2, "0")}`;
}

export interface DurablePaymentProviderEvent {
  provider: Extract<PaymentRequestProvider, "stripe" | "oxapay">;
  providerEventId: string;
  paymentRequestId: string;
  disposition: PaymentProviderEventDisposition;
  providerTxRef: string;
  payloadDigest: string;
  amountCents?: number;
  currency?: string;
  proof: Record<string, unknown>;
  error?: string;
}

export type DurablePaymentCallback =
  | {
      name: "PaymentSettled";
      paymentRequestId: string;
      provider: Extract<PaymentRequestProvider, "stripe" | "oxapay">;
      txRef: string;
      providerEventId: string;
      amountCents: number;
      currency: string;
      settledAt: Date;
    }
  | {
      name: "PaymentFailed";
      paymentRequestId: string;
      provider: Extract<PaymentRequestProvider, "stripe" | "oxapay">;
      txRef: string;
      providerEventId: string;
      error: string;
      failedAt: Date;
    };

export interface ProcessedPaymentProviderEvent {
  callback: DurablePaymentCallback;
  callbackState: PaymentCallbackState;
  replay: boolean;
}

export class PaymentProviderEventConflictError extends ElizaError {
  override readonly name = "PaymentProviderEventConflictError";

  constructor(message: string) {
    super(message, {
      code: "PAYMENT_PROVIDER_EVENT_CONFLICT",
      severity: "fatal",
    });
  }
}

function requiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) {
    throw new PaymentProviderEventConflictError(`${field} must be 1-512 characters`);
  }
  return trimmed;
}

function normalizedCurrency(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3,8}$/.test(normalized)) {
    throw new PaymentProviderEventConflictError("Provider currency is invalid");
  }
  return normalized;
}

function proofText(proof: Record<string, unknown>, key: string): string | null {
  const value = proof[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function intentText(intent: Record<string, unknown>, key: string): string | null {
  const value = intent[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validateProviderBinding(
  event: DurablePaymentProviderEvent,
  request: typeof paymentRequests.$inferSelect,
): void {
  if (request.provider !== event.provider) {
    throw new PaymentProviderEventConflictError(
      `Provider ${event.provider} cannot fulfill ${request.provider} payment request`,
    );
  }

  if (event.provider === "stripe") {
    const expectedSession = intentText(request.provider_intent, "stripe_session_id");
    const actualSession = proofText(event.proof, "stripe_session_id");
    if (
      !expectedSession ||
      (event.disposition === "settled" && expectedSession !== actualSession) ||
      (actualSession !== null && expectedSession !== actualSession)
    ) {
      throw new PaymentProviderEventConflictError("Stripe Checkout session does not match request");
    }
    const proofIntent = proofText(event.proof, "stripe_payment_intent_id");
    if (proofIntent && proofIntent !== event.providerTxRef) {
      throw new PaymentProviderEventConflictError("Stripe payment intent does not match tx ref");
    }
    const expectedIntent = intentText(request.provider_intent, "stripe_payment_intent_id");
    if (expectedIntent && expectedIntent !== event.providerTxRef) {
      throw new PaymentProviderEventConflictError("Stripe payment intent does not match request");
    }
    if (
      event.disposition === "settled" &&
      proofText(event.proof, "stripe_payment_status") !== "paid"
    ) {
      throw new PaymentProviderEventConflictError("Stripe Checkout session is not paid");
    }
    return;
  }

  const expectedTrack = intentText(request.provider_intent, "oxapay_track_id");
  const proofTrack = proofText(event.proof, "oxapay_track_id");
  const proofOrder = proofText(event.proof, "oxapay_order_id");
  if (
    !expectedTrack ||
    expectedTrack !== event.providerTxRef ||
    proofTrack !== event.providerTxRef
  ) {
    throw new PaymentProviderEventConflictError("OxaPay track id does not match request");
  }
  if (proofOrder !== request.id) {
    throw new PaymentProviderEventConflictError("OxaPay order id does not match request");
  }
  if (event.disposition === "settled" && proofText(event.proof, "oxapay_status") !== "paid") {
    throw new PaymentProviderEventConflictError("OxaPay invoice is not paid");
  }
}

function validateSettlementAmount(
  event: DurablePaymentProviderEvent,
  request: typeof paymentRequests.$inferSelect,
): { amountCents: number; currency: string } {
  if (!Number.isSafeInteger(event.amountCents) || (event.amountCents ?? 0) <= 0) {
    throw new PaymentProviderEventConflictError("Provider amount must be positive safe cents");
  }
  if ((event.amountCents ?? 0) > MAX_PAYMENT_REQUEST_LEDGER_CENTS) {
    throw new PaymentProviderEventConflictError(
      "Provider amount exceeds the credit ledger numeric range",
    );
  }
  const requestAmountCents = Number(request.amount_cents);
  if (!Number.isSafeInteger(requestAmountCents) || event.amountCents !== requestAmountCents) {
    throw new PaymentProviderEventConflictError("Provider amount does not match server quote");
  }
  if (!event.currency) {
    throw new PaymentProviderEventConflictError("Provider currency is required for settlement");
  }
  const currency = normalizedCurrency(event.currency);
  const requestCurrency = normalizedCurrency(request.currency);
  if (requestCurrency !== "USD" || currency !== "USD") {
    throw new PaymentProviderEventConflictError(
      "Credit top-up settlement requires a USD server quote and provider payment",
    );
  }
  return { amountCents: event.amountCents, currency };
}

function assertReplayBinding(
  row: typeof paymentRequestEvents.$inferSelect,
  event: DurablePaymentProviderEvent,
): void {
  if (
    row.payment_request_id !== event.paymentRequestId ||
    row.provider !== event.provider ||
    row.provider_event_id !== event.providerEventId ||
    row.provider_tx_ref !== event.providerTxRef ||
    row.provider_disposition !== event.disposition ||
    row.payload_digest !== event.payloadDigest
  ) {
    throw new PaymentProviderEventConflictError(
      "Provider event identity was replayed with a different payload binding",
    );
  }
}

function callbackFromPayload(
  payload: Record<string, unknown>,
  callbackState: PaymentCallbackState | null,
): ProcessedPaymentProviderEvent["callback"] {
  if (payload.name === "PaymentSettled") {
    return {
      name: "PaymentSettled",
      paymentRequestId: String(payload.paymentRequestId),
      provider: payload.provider as "stripe" | "oxapay",
      txRef: String(payload.txRef),
      providerEventId: String(payload.providerEventId),
      amountCents: Number(payload.amountCents),
      currency: String(payload.currency),
      settledAt: new Date(String(payload.occurredAt)),
    };
  }
  if (payload.name === "PaymentFailed") {
    return {
      name: "PaymentFailed",
      paymentRequestId: String(payload.paymentRequestId),
      provider: payload.provider as "stripe" | "oxapay",
      txRef: String(payload.txRef),
      providerEventId: String(payload.providerEventId),
      error: String(payload.error),
      failedAt: new Date(String(payload.occurredAt)),
    };
  }
  throw new PaymentProviderEventConflictError(
    `Durable callback payload is invalid (${callbackState ?? "missing state"})`,
  );
}

export async function processPaymentProviderEvent(
  rawEvent: DurablePaymentProviderEvent,
): Promise<ProcessedPaymentProviderEvent> {
  const event = {
    ...rawEvent,
    providerEventId: requiredText(rawEvent.providerEventId, "providerEventId"),
    paymentRequestId: requiredText(rawEvent.paymentRequestId, "paymentRequestId"),
    providerTxRef: requiredText(rawEvent.providerTxRef, "providerTxRef"),
    payloadDigest: rawEvent.payloadDigest.toLowerCase(),
    proof: curatePaymentRequestSettlementProof(rawEvent.provider, rawEvent.proof),
  };
  if (!/^[a-f0-9]{64}$/.test(event.payloadDigest)) {
    throw new PaymentProviderEventConflictError("payloadDigest must be a SHA-256 hex digest");
  }

  let organizationIdToInvalidate: string | null = null;
  const processed = await writeTransaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, event.paymentRequestId))
      .for("update");
    if (!request) {
      throw new PaymentProviderEventConflictError("Payment request not found");
    }
    validateProviderBinding(event, request);

    const occurredAt = new Date();
    const amount =
      event.disposition === "settled" ? validateSettlementAmount(event, request) : null;
    if (event.disposition === "settled") {
      organizationIdToInvalidate = request.organization_id;
    }
    const callbackPayload: Record<string, unknown> =
      event.disposition === "settled"
        ? {
            name: "PaymentSettled",
            paymentRequestId: request.id,
            provider: event.provider,
            providerEventId: event.providerEventId,
            txRef: event.providerTxRef,
            amountCents: amount?.amountCents,
            currency: amount?.currency,
            occurredAt: occurredAt.toISOString(),
          }
        : {
            name: "PaymentFailed",
            paymentRequestId: request.id,
            provider: event.provider,
            providerEventId: event.providerEventId,
            txRef: event.providerTxRef,
            error: event.error ?? `${event.provider} payment failed`,
            occurredAt: occurredAt.toISOString(),
          };

    const [existingEvent] = await tx
      .select()
      .from(paymentRequestEvents)
      .where(
        and(
          eq(paymentRequestEvents.event_name, "webhook.received"),
          eq(paymentRequestEvents.provider, event.provider),
          eq(paymentRequestEvents.provider_event_id, event.providerEventId),
        ),
      )
      .limit(1);
    if (existingEvent) assertReplayBinding(existingEvent, event);
    if (!existingEvent && event.disposition === "settled") {
      const [existingTransaction] = await tx
        .select()
        .from(paymentRequestEvents)
        .where(
          and(
            eq(paymentRequestEvents.event_name, "webhook.received"),
            eq(paymentRequestEvents.provider, event.provider),
            eq(paymentRequestEvents.provider_tx_ref, event.providerTxRef),
            eq(paymentRequestEvents.provider_disposition, "settled"),
          ),
        )
        .limit(1);
      if (existingTransaction) {
        const payload = existingTransaction.redacted_payload;
        if (
          existingTransaction.payment_request_id !== request.id ||
          payload.paymentRequestId !== request.id ||
          payload.provider !== event.provider ||
          payload.txRef !== event.providerTxRef ||
          payload.amountCents !== amount?.amountCents ||
          payload.currency !== amount?.currency
        ) {
          throw new PaymentProviderEventConflictError(
            "Provider transaction was replayed with a different settlement binding",
          );
        }
        if (
          request.status !== "settled" ||
          request.settlement_tx_ref !== event.providerTxRef ||
          !request.settled_at ||
          !request.settlement_proof ||
          !existingTransaction.provider_event_id ||
          !existingTransaction.payload_digest ||
          !amount
        ) {
          throw new PaymentProviderEventConflictError(
            "Existing provider transaction has incomplete settlement authority",
          );
        }
        await projectPaymentRequestReceipt(tx, {
          organizationId: request.organization_id,
          paymentRequestId: request.id,
          provider: event.provider,
          providerTxRef: event.providerTxRef,
          providerEventId: existingTransaction.provider_event_id,
          amountCents: amount.amountCents,
          currency: amount.currency,
          settledAt: request.settled_at,
          payloadDigest: existingTransaction.payload_digest,
          settlementProof: request.settlement_proof,
        });
        return {
          callback: callbackFromPayload(payload, existingTransaction.callback_state),
          callbackState: existingTransaction.callback_state ?? "pending",
          replay: true,
        };
      }
    }
    const [eventRow] = existingEvent
      ? [existingEvent]
      : await tx
          .insert(paymentRequestEvents)
          .values({
            payment_request_id: request.id,
            event_name: "webhook.received",
            redacted_payload: callbackPayload,
            provider: event.provider,
            provider_event_id: event.providerEventId,
            provider_tx_ref: event.providerTxRef,
            provider_disposition: event.disposition,
            payload_digest: event.payloadDigest,
            callback_state: "pending",
            occurred_at: occurredAt,
          })
          .returning();
    if (!eventRow) {
      throw new PaymentProviderEventConflictError("Provider event persistence returned no row");
    }
    assertReplayBinding(eventRow, event);
    const replay = Boolean(existingEvent);

    if (event.disposition === "settled") {
      if (!amount) {
        throw new PaymentProviderEventConflictError("Settled provider event has no amount");
      }
      if (request.status === "settled" && request.settlement_tx_ref !== event.providerTxRef) {
        throw new PaymentProviderEventConflictError(
          "Payment request was already settled by another provider transaction",
        );
      }

      await projectPaymentRequestReceipt(tx, {
        organizationId: request.organization_id,
        paymentRequestId: request.id,
        provider: event.provider,
        providerTxRef: event.providerTxRef,
        providerEventId: event.providerEventId,
        amountCents: amount.amountCents,
        currency: amount.currency,
        settledAt: request.settled_at ?? occurredAt,
        payloadDigest: event.payloadDigest,
        settlementProof: event.proof,
      });

      const credit = await creditsService.addCredits({
        organizationId: request.organization_id,
        amount: formatUsdFromCents(amount.amountCents),
        description: `${event.provider} payment request credit purchase`,
        metadata: {
          type: "payment_request_topup",
          paymentRequestId: request.id,
          provider: event.provider,
          providerEventId: event.providerEventId,
          providerTxRef: event.providerTxRef,
          amountCents: amount.amountCents,
          currency: amount.currency,
        },
        stripePaymentIntentId:
          event.provider === "stripe"
            ? event.providerTxRef
            : `payment-request:${request.organization_id}:${event.provider}:${request.id}`,
        db: tx,
        deferCacheInvalidation: true,
      });
      const creditMetadata = credit.transaction.metadata;
      if (
        credit.transaction.organization_id !== request.organization_id ||
        credit.transaction.type !== "credit" ||
        !new Decimal(String(credit.transaction.amount)).eq(
          formatUsdFromCents(amount.amountCents),
        ) ||
        creditMetadata.type !== "payment_request_topup" ||
        creditMetadata.paymentRequestId !== request.id ||
        creditMetadata.provider !== event.provider ||
        creditMetadata.providerTxRef !== event.providerTxRef ||
        creditMetadata.amountCents !== amount.amountCents ||
        creditMetadata.currency !== amount.currency
      ) {
        throw new PaymentProviderEventConflictError(
          "Existing credit idempotency row does not match payment settlement",
        );
      }

      if (request.status !== "settled") {
        await tx
          .update(paymentRequestEvents)
          .set({
            callback_state: "superseded",
            callback_claimed_until: null,
            callback_next_attempt_at: null,
          })
          .where(
            and(
              eq(paymentRequestEvents.payment_request_id, request.id),
              eq(paymentRequestEvents.event_name, "webhook.received"),
              eq(paymentRequestEvents.provider_disposition, "failed"),
              inArray(paymentRequestEvents.callback_state, ["pending", "failed"]),
            ),
          );
        await tx
          .update(paymentRequests)
          .set({
            status: "settled",
            settled_at: occurredAt,
            settlement_tx_ref: event.providerTxRef,
            settlement_proof: event.proof,
            updated_at: occurredAt,
          })
          .where(eq(paymentRequests.id, request.id));
        await tx.insert(paymentRequestEvents).values({
          payment_request_id: request.id,
          event_name: "payment.settled",
          redacted_payload: callbackPayload,
          occurred_at: occurredAt,
        });
      }
    } else if (request.status === "pending" || request.status === "delivered") {
      await tx
        .update(paymentRequests)
        .set({ status: "failed", updated_at: occurredAt })
        .where(eq(paymentRequests.id, request.id));
      await tx.insert(paymentRequestEvents).values({
        payment_request_id: request.id,
        event_name: "payment.failed",
        redacted_payload: callbackPayload,
        occurred_at: occurredAt,
      });
    } else if (request.status === "settled") {
      await tx
        .update(paymentRequestEvents)
        .set({
          callback_state: "superseded",
          callback_claimed_until: null,
          callback_next_attempt_at: null,
        })
        .where(eq(paymentRequestEvents.id, eventRow.id));
      eventRow.callback_state = "superseded";
    }

    return {
      callback: callbackFromPayload(eventRow.redacted_payload, eventRow.callback_state),
      callbackState: eventRow.callback_state ?? "pending",
      replay,
    };
  });
  if (organizationIdToInvalidate) {
    await creditsService.invalidateCreditCaches(organizationIdToInvalidate);
  }
  return processed;
}

export async function markPaymentCallbackAttempt(
  provider: Extract<PaymentRequestProvider, "stripe" | "oxapay">,
  providerEventId: string,
  result: { dispatched: true } | { dispatched: false; error: string },
  claimedUntil: string,
): Promise<boolean> {
  return writeTransaction(async (tx) => {
    const [updated] = await tx
      .update(paymentRequestEvents)
      .set({
        callback_state: result.dispatched ? "dispatched" : "failed",
        callback_attempts: sql`${paymentRequestEvents.callback_attempts} + 1`,
        callback_last_error: result.dispatched ? null : result.error,
        callback_claimed_until: null,
        callback_next_attempt_at: result.dispatched
          ? null
          : sql`clock_timestamp() + interval '60 seconds'`,
      })
      .where(
        and(
          eq(paymentRequestEvents.event_name, "webhook.received"),
          eq(paymentRequestEvents.provider, provider),
          eq(paymentRequestEvents.provider_event_id, providerEventId),
          // The exact database timestamp is this attempt's identity. A
          // successor can only claim after it expires and gets a later value.
          sql`${paymentRequestEvents.callback_claimed_until} = ${claimedUntil}::timestamptz`,
          inArray(paymentRequestEvents.callback_state, ["pending", "failed"]),
        ),
      )
      .returning();
    if (!updated) return false;
    await tx.insert(paymentRequestEvents).values({
      payment_request_id: updated.payment_request_id,
      event_name: result.dispatched ? "callback.dispatched" : "callback.failed",
      redacted_payload: {
        provider,
        providerEventId,
        error: result.dispatched ? undefined : result.error,
      },
    });
    return true;
  });
}

interface ClaimedPaymentCallback {
  id: string;
  provider: "stripe" | "oxapay";
  providerEventId: string;
  payload: Record<string, unknown>;
  callbackUrl: string | null;
  callbackSecret: string | null;
  /** Full PostgreSQL precision; never round-trip this CAS identity through Date. */
  claimedUntil: string;
}

async function claimPaymentCallbacks(input?: {
  provider?: "stripe" | "oxapay";
  providerEventId?: string;
  limit?: number;
  excludeIds?: readonly string[];
}): Promise<ClaimedPaymentCallback[]> {
  const now = sql`clock_timestamp()`;
  const limit = Math.min(Math.max(input?.limit ?? 25, 1), 100);
  return writeTransaction(async (tx) => {
    const conditions = [
      eq(paymentRequestEvents.event_name, "webhook.received" as const),
      inArray(paymentRequestEvents.callback_state, ["pending", "failed"]),
      lt(paymentRequestEvents.callback_attempts, MAX_CALLBACK_ATTEMPTS),
      or(
        isNull(paymentRequestEvents.callback_next_attempt_at),
        lte(paymentRequestEvents.callback_next_attempt_at, now),
      ),
      or(
        isNull(paymentRequestEvents.callback_claimed_until),
        lt(paymentRequestEvents.callback_claimed_until, now),
      ),
    ];
    if (input?.excludeIds?.length) {
      conditions.push(notInArray(paymentRequestEvents.id, [...input.excludeIds]));
    }
    if (input?.provider) conditions.push(eq(paymentRequestEvents.provider, input.provider));
    if (input?.providerEventId) {
      conditions.push(eq(paymentRequestEvents.provider_event_id, input.providerEventId));
    }
    const rows = await tx
      .select({
        id: paymentRequestEvents.id,
        provider: paymentRequestEvents.provider,
        providerEventId: paymentRequestEvents.provider_event_id,
        payload: paymentRequestEvents.redacted_payload,
        callbackUrl: paymentRequests.callback_url,
        callbackSecret: paymentRequests.callback_secret,
      })
      .from(paymentRequestEvents)
      .innerJoin(paymentRequests, eq(paymentRequests.id, paymentRequestEvents.payment_request_id))
      .where(and(...conditions))
      .orderBy(asc(paymentRequestEvents.occurred_at))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return [];
    const claims = await tx
      .update(paymentRequestEvents)
      .set({ callback_claimed_until: sql`clock_timestamp() + interval '60 seconds'` })
      .where(
        inArray(
          paymentRequestEvents.id,
          rows.map((row) => row.id),
        ),
      )
      .returning({
        id: paymentRequestEvents.id,
        claimedUntil: sql<string>`${paymentRequestEvents.callback_claimed_until}::text`,
      });
    const deadlines = new Map(claims.map((claim) => [claim.id, claim.claimedUntil]));
    return rows.map((row) => {
      if (!row.provider || !row.providerEventId) {
        throw new PaymentProviderEventConflictError(
          "Claimed payment callback has no provider identity",
        );
      }
      const claimedUntil = deadlines.get(row.id);
      if (!claimedUntil) {
        throw new PaymentProviderEventConflictError("Payment callback claim was not persisted");
      }
      return {
        ...row,
        provider: row.provider as "stripe" | "oxapay",
        providerEventId: row.providerEventId,
        claimedUntil,
      };
    });
  });
}

/** Returns the primary-clock budget only while this exact attempt still owns dispatch. */
async function remainingCallbackLeaseMs(job: ClaimedPaymentCallback): Promise<number | null> {
  const [row] = await dbWrite
    .select({
      remainingMs: sql<string>`EXTRACT(EPOCH FROM (${paymentRequestEvents.callback_claimed_until} - clock_timestamp())) * 1000`,
    })
    .from(paymentRequestEvents)
    .where(
      and(
        eq(paymentRequestEvents.id, job.id),
        sql`${paymentRequestEvents.callback_claimed_until} = ${job.claimedUntil}::timestamptz`,
        inArray(paymentRequestEvents.callback_state, ["pending", "failed"]),
        sql`${paymentRequestEvents.callback_claimed_until} > clock_timestamp()`,
      ),
    );
  if (!row) return null;
  const remainingMs = Number(row.remainingMs);
  if (!Number.isFinite(remainingMs)) {
    throw new PaymentProviderEventConflictError("Payment callback lease budget is invalid");
  }
  return remainingMs;
}

async function callbackSignature(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function dispatchPaymentCallbacks(input?: {
  provider?: "stripe" | "oxapay";
  providerEventId?: string;
  limit?: number;
}): Promise<{ claimed: number; dispatched: number; failed: number }> {
  const limit = Math.min(Math.max(input?.limit ?? 25, 1), 100);
  const visited: string[] = [];
  let claimed = 0;
  let dispatched = 0;
  let failed = 0;
  for (let index = 0; index < limit; index++) {
    // Claim at dispatch time, not before earlier callbacks spend their HTTP
    // timeout. Exclusions keep a long run from retrying its own failed jobs.
    const [job] = await claimPaymentCallbacks({ ...input, limit: 1, excludeIds: visited });
    if (!job) break;
    visited.push(job.id);
    claimed++;
    try {
      if (job.callbackUrl) {
        const budgetStartedAt = performance.now();
        const remainingMs = await remainingCallbackLeaseMs(job);
        if (remainingMs === null) continue;
        const body = JSON.stringify(job.payload);
        const timestamp = new Date().toISOString();
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "X-Eliza-Event": String(job.payload.name ?? "payment.updated"),
          "X-Eliza-Timestamp": timestamp,
          "X-Eliza-Delivery": job.providerEventId,
        };
        if (job.callbackSecret) {
          headers["X-Eliza-Signature"] = await callbackSignature(
            job.callbackSecret,
            timestamp,
            body,
          );
        }
        // Subtract the full local round-trip/signing duration conservatively.
        // safeFetch checks this signal before and after DNS, keeping a
        // delayed lookup within this attempt's remaining dispatch budget.
        const timeoutMs = Math.floor(
          Math.min(10_000, remainingMs - (performance.now() - budgetStartedAt)),
        );
        if (timeoutMs <= 0) continue;
        const response = await safeFetch(job.callbackUrl, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`Callback returned ${response.status}`);
      }
      if (
        await markPaymentCallbackAttempt(
          job.provider,
          job.providerEventId,
          { dispatched: true },
          job.claimedUntil,
        )
      )
        dispatched += 1;
    } catch (error) {
      // error-policy:J7 settlement is already durable; retain bounded retry state.
      const message = error instanceof Error ? error.message : String(error);
      const recorded = await markPaymentCallbackAttempt(
        job.provider,
        job.providerEventId,
        { dispatched: false, error: message },
        job.claimedUntil,
      );
      logger.warn("[PaymentRequestSettlement] Callback delivery failed", {
        provider: job.provider,
        providerEventId: job.providerEventId,
        error: message,
      });
      if (recorded) failed += 1;
    }
  }
  return { claimed, dispatched, failed };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
