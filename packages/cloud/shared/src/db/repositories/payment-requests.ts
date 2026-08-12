// Persists payment requests records for cloud services through the shared DB boundary.
import { and, desc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import { dbWrite as db } from "../client";
import {
  type NewPaymentRequest as NewPaymentRequestDbRow,
  type NewPaymentRequestEvent as NewPaymentRequestEventDbRow,
  type PaymentContext,
  type PaymentRequestRow as PaymentRequestDbRow,
  type PaymentRequestEventRow as PaymentRequestEventDbRow,
  type PaymentRequestProvider,
  type PaymentRequestStatus,
  paymentRequestEvents,
  paymentRequests,
} from "../schemas/payment-requests";
import { parsePaymentAmountCents } from "./payment-requests-numeric";

export type ProviderIntentKey = "stripe_session_id" | "oxapay_track_id" | "x402_request_id";

export interface ListPaymentRequestsFilter {
  organizationId: string;
  status?: PaymentRequestStatus;
  agentId?: string;
  provider?: PaymentRequestProvider;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export interface PaymentRequestRow {
  id: string;
  organizationId: string;
  agentId: string | null;
  appId: string | null;
  provider: PaymentRequestProvider;
  amountCents: number;
  currency: string;
  reason: string | null;
  paymentContext: PaymentContext;
  payerIdentityId: string | null;
  payerUserId: string | null;
  payerOrganizationId?: string | null;
  status: PaymentRequestStatus;
  hostedUrl: string | null;
  callbackUrl: string | null;
  callbackSecret: string | null;
  providerIntent: Record<string, unknown>;
  settledAt: Date | null;
  settlementTxRef: string | null;
  settlementProof: Record<string, unknown> | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
  successUrl?: string | null;
  cancelUrl?: string | null;
}

export interface NewPaymentRequest {
  organizationId: string;
  agentId?: string | null;
  appId?: string | null;
  provider: PaymentRequestProvider;
  amountCents: number;
  currency: string;
  reason?: string | null;
  paymentContext: PaymentContext;
  payerIdentityId?: string | null;
  payerUserId?: string | null;
  status?: PaymentRequestStatus;
  hostedUrl?: string | null;
  callbackUrl?: string | null;
  callbackSecret?: string | null;
  providerIntent?: Record<string, unknown>;
  settledAt?: Date | null;
  settlementTxRef?: string | null;
  settlementProof?: Record<string, unknown> | null;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
}

export interface NewPaymentRequestEvent {
  paymentRequestId: string;
  eventName: NewPaymentRequestEventDbRow["event_name"];
  redactedPayload?: Record<string, unknown>;
}

export type PaymentRequestEventRow = PaymentRequestEventDbRow;

function toDbInsert(input: NewPaymentRequest): NewPaymentRequestDbRow {
  return {
    organization_id: input.organizationId,
    agent_id: input.agentId ?? null,
    app_id: input.appId ?? null,
    provider: input.provider,
    amount_cents: BigInt(input.amountCents),
    currency: input.currency,
    reason: input.reason ?? null,
    payment_context: input.paymentContext,
    payer_identity_id: input.payerIdentityId ?? null,
    payer_user_id: input.payerUserId ?? null,
    status: input.status ?? "pending",
    hosted_url: input.hostedUrl ?? null,
    callback_url: input.callbackUrl ?? null,
    callback_secret: input.callbackSecret ?? null,
    provider_intent: input.providerIntent ?? {},
    settled_at: input.settledAt ?? null,
    settlement_tx_ref: input.settlementTxRef ?? null,
    settlement_proof: input.settlementProof ?? null,
    expires_at: input.expiresAt,
    metadata: input.metadata ?? {},
  };
}

function toDomain(row: PaymentRequestDbRow): PaymentRequestRow {
  return {
    id: row.id,
    organizationId: row.organization_id,
    agentId: row.agent_id,
    appId: row.app_id,
    provider: row.provider,
    amountCents: parsePaymentAmountCents(row.amount_cents, "amount_cents"),
    currency: row.currency,
    reason: row.reason,
    paymentContext: row.payment_context,
    payerIdentityId: row.payer_identity_id,
    payerUserId: row.payer_user_id,
    payerOrganizationId: row.organization_id,
    status: row.status,
    hostedUrl: row.hosted_url,
    callbackUrl: row.callback_url,
    callbackSecret: row.callback_secret,
    providerIntent: row.provider_intent,
    settledAt: row.settled_at,
    settlementTxRef: row.settlement_tx_ref,
    settlementProof: row.settlement_proof,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: row.metadata,
  };
}

function toDbEvent(input: NewPaymentRequestEvent): NewPaymentRequestEventDbRow {
  return {
    payment_request_id: input.paymentRequestId,
    event_name: input.eventName,
    redacted_payload: input.redactedPayload ?? {},
  };
}

function lifecycleEventPayload(
  row: PaymentRequestDbRow,
  status: "delivered" | "settled" | "failed" | "expired" | "canceled",
  detail?: { error?: string; txRef?: string },
): Record<string, unknown> {
  return {
    paymentRequestId: row.id,
    organizationId: row.organization_id,
    provider: row.provider,
    amountCents: parsePaymentAmountCents(row.amount_cents, "amount_cents"),
    currency: row.currency,
    status,
    txRef: detail?.txRef ?? null,
    error: detail?.error,
  };
}

export class PaymentRequestsRepository {
  async createPaymentRequest(input: NewPaymentRequest): Promise<PaymentRequestRow> {
    const [row] = await db.insert(paymentRequests).values(toDbInsert(input)).returning();
    return toDomain(row);
  }

  async getPaymentRequest(id: string): Promise<PaymentRequestRow | null> {
    const [row] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, id))
      .limit(1);
    return row ? toDomain(row) : null;
  }

  async listPaymentRequests(filter: ListPaymentRequestsFilter): Promise<PaymentRequestRow[]> {
    const conditions = [eq(paymentRequests.organization_id, filter.organizationId)];
    if (filter.status) conditions.push(eq(paymentRequests.status, filter.status));
    if (filter.agentId) conditions.push(eq(paymentRequests.agent_id, filter.agentId));
    if (filter.provider) conditions.push(eq(paymentRequests.provider, filter.provider));
    if (filter.since) conditions.push(gte(paymentRequests.created_at, filter.since));
    if (filter.until) conditions.push(lte(paymentRequests.created_at, filter.until));

    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;

    const rows = await db
      .select()
      .from(paymentRequests)
      .where(and(...conditions))
      .orderBy(desc(paymentRequests.created_at))
      .limit(limit)
      .offset(offset);
    return rows.map(toDomain);
  }

  async updatePaymentRequestIntent(
    id: string,
    providerIntent: Record<string, unknown>,
    hostedUrl: string | null,
  ): Promise<PaymentRequestRow | null> {
    const [row] = await db
      .update(paymentRequests)
      .set({ provider_intent: providerIntent, hosted_url: hostedUrl, updated_at: new Date() })
      .where(eq(paymentRequests.id, id))
      .returning();
    return row ? toDomain(row) : null;
  }

  async initializePaymentRequest(
    id: string,
    providerIntent: Record<string, unknown>,
    hostedUrl: string | null,
    initializedAt: Date,
  ): Promise<PaymentRequestRow | null> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(paymentRequests)
        .set({
          status: "delivered",
          provider_intent: providerIntent,
          hosted_url: hostedUrl,
          updated_at: initializedAt,
        })
        .where(
          and(
            eq(paymentRequests.id, id),
            eq(paymentRequests.status, "pending"),
            gt(paymentRequests.expires_at, initializedAt),
          ),
        )
        .returning();
      if (!row) return null;
      await tx.insert(paymentRequestEvents).values({
        payment_request_id: row.id,
        event_name: "payment.delivered",
        redacted_payload: lifecycleEventPayload(row, "delivered"),
      });
      return toDomain(row);
    });
  }

  async failPaymentRequest(
    id: string,
    error: string,
    failedAt: Date,
  ): Promise<PaymentRequestRow | null> {
    const failable: PaymentRequestStatus[] = ["pending", "delivered"];
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(paymentRequests)
        .set({ status: "failed", updated_at: failedAt })
        .where(
          and(
            eq(paymentRequests.id, id),
            inArray(paymentRequests.status, failable),
            gt(paymentRequests.expires_at, failedAt),
          ),
        )
        .returning();
      if (!row) return null;
      await tx.insert(paymentRequestEvents).values({
        payment_request_id: row.id,
        event_name: "payment.failed",
        redacted_payload: lifecycleEventPayload(row, "failed", { error }),
      });
      return toDomain(row);
    });
  }

  async cancelPaymentRequest(
    id: string,
    organizationId: string,
    reason: string | undefined,
    canceledAt: Date,
  ): Promise<PaymentRequestRow | null> {
    const cancelable: PaymentRequestStatus[] = ["pending", "delivered"];
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(paymentRequests)
        .set({ status: "canceled", updated_at: canceledAt })
        .where(
          and(
            eq(paymentRequests.id, id),
            eq(paymentRequests.organization_id, organizationId),
            inArray(paymentRequests.status, cancelable),
            gt(paymentRequests.expires_at, canceledAt),
          ),
        )
        .returning();
      if (!row) return null;
      await tx.insert(paymentRequestEvents).values({
        payment_request_id: row.id,
        event_name: "payment.canceled",
        redacted_payload: lifecycleEventPayload(row, "canceled", { error: reason }),
      });
      return toDomain(row);
    });
  }

  /**
   * Atomically wins settlement only while the request is payable. The strict
   * `expires_at > settledAt` predicate makes the database authoritative at the
   * exact deadline; the event is committed with the terminal transition.
   */
  async settlePaymentRequest(
    id: string,
    settledAt: Date,
    settlementTxRef: string,
    settlementProof: Record<string, unknown>,
  ): Promise<PaymentRequestRow | null> {
    const payable: PaymentRequestStatus[] = ["pending", "delivered"];
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(paymentRequests)
        .set({
          status: "settled",
          settled_at: settledAt,
          settlement_tx_ref: settlementTxRef,
          settlement_proof: settlementProof,
          updated_at: settledAt,
        })
        .where(
          and(
            eq(paymentRequests.id, id),
            inArray(paymentRequests.status, payable),
            gt(paymentRequests.expires_at, settledAt),
          ),
        )
        .returning();

      if (!row) return null;
      await tx.insert(paymentRequestEvents).values({
        payment_request_id: row.id,
        event_name: "payment.settled",
        redacted_payload: lifecycleEventPayload(row, "settled", { txRef: settlementTxRef }),
      });
      return toDomain(row);
    });
  }

  async recordPaymentRequestEvent(input: NewPaymentRequestEvent): Promise<PaymentRequestEventRow> {
    const [row] = await db.insert(paymentRequestEvents).values(toDbEvent(input)).returning();
    return row;
  }

  async expirePastPaymentRequests(now: Date): Promise<string[]> {
    const expirable: PaymentRequestStatus[] = ["pending", "delivered"];
    return db.transaction(async (tx) => {
      const rows = await tx
        .update(paymentRequests)
        .set({ status: "expired", updated_at: now })
        .where(
          and(inArray(paymentRequests.status, expirable), lte(paymentRequests.expires_at, now)),
        )
        .returning();
      if (rows.length > 0) {
        await tx.insert(paymentRequestEvents).values(
          rows.map((row) => ({
            payment_request_id: row.id,
            event_name: "payment.expired" as const,
            redacted_payload: lifecycleEventPayload(row, "expired"),
          })),
        );
      }
      return rows.map((row) => row.id);
    });
  }

  /**
   * Org-scoped variant of {@link expirePastPaymentRequests}: only flips past-due
   * `pending`/`delivered` rows belonging to `organizationId`. The global
   * variant stays for the system cron janitor.
   */
  async expirePastPaymentRequestsForOrg(organizationId: string, now: Date): Promise<string[]> {
    const expirable: PaymentRequestStatus[] = ["pending", "delivered"];
    return db.transaction(async (tx) => {
      const rows = await tx
        .update(paymentRequests)
        .set({ status: "expired", updated_at: now })
        .where(
          and(
            eq(paymentRequests.organization_id, organizationId),
            inArray(paymentRequests.status, expirable),
            lte(paymentRequests.expires_at, now),
          ),
        )
        .returning();
      if (rows.length > 0) {
        await tx.insert(paymentRequestEvents).values(
          rows.map((row) => ({
            payment_request_id: row.id,
            event_name: "payment.expired" as const,
            redacted_payload: lifecycleEventPayload(row, "expired"),
          })),
        );
      }
      return rows.map((row) => row.id);
    });
  }

  /**
   * Expire a SINGLE past-due payment request by id. Caller (service) enforces
   * org ownership, mirroring cancel(). Only flips a row still in an expirable
   * status AND past its expiry, so it is idempotent and never touches a
   * settled/canceled request. Returns true iff a row changed.
   */
  async expirePastPaymentRequest(id: string, now: Date): Promise<boolean> {
    const expirable: PaymentRequestStatus[] = ["pending", "delivered"];
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(paymentRequests)
        .set({ status: "expired", updated_at: now })
        .where(
          and(
            eq(paymentRequests.id, id),
            inArray(paymentRequests.status, expirable),
            lte(paymentRequests.expires_at, now),
          ),
        )
        .returning();
      if (!row) return false;
      await tx.insert(paymentRequestEvents).values({
        payment_request_id: row.id,
        event_name: "payment.expired",
        redacted_payload: lifecycleEventPayload(row, "expired"),
      });
      return true;
    });
  }

  async findPaymentRequestByProviderIntentKey(
    key: ProviderIntentKey,
    value: string,
  ): Promise<PaymentRequestRow | null> {
    const [row] = await db
      .select()
      .from(paymentRequests)
      .where(sql`${paymentRequests.provider_intent} ->> ${key} = ${value}`)
      .limit(1);
    return row ? toDomain(row) : null;
  }
}

export const paymentRequestsRepository = new PaymentRequestsRepository();

export type { PaymentContext, PaymentRequestProvider, PaymentRequestStatus };
