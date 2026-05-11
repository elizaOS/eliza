import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { dbWrite as db } from "@/db/client";
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
} from "@/db/schemas/payment-requests";

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

function toDbPatch(input: Partial<NewPaymentRequest>): Partial<NewPaymentRequestDbRow> {
  const patch: Partial<NewPaymentRequestDbRow> = {};
  if (input.organizationId !== undefined) patch.organization_id = input.organizationId;
  if (input.agentId !== undefined) patch.agent_id = input.agentId;
  if (input.appId !== undefined) patch.app_id = input.appId;
  if (input.provider !== undefined) patch.provider = input.provider;
  if (input.amountCents !== undefined) patch.amount_cents = BigInt(input.amountCents);
  if (input.currency !== undefined) patch.currency = input.currency;
  if (input.reason !== undefined) patch.reason = input.reason;
  if (input.paymentContext !== undefined) patch.payment_context = input.paymentContext;
  if (input.payerIdentityId !== undefined) patch.payer_identity_id = input.payerIdentityId;
  if (input.payerUserId !== undefined) patch.payer_user_id = input.payerUserId;
  if (input.status !== undefined) patch.status = input.status;
  if (input.hostedUrl !== undefined) patch.hosted_url = input.hostedUrl;
  if (input.callbackUrl !== undefined) patch.callback_url = input.callbackUrl;
  if (input.callbackSecret !== undefined) patch.callback_secret = input.callbackSecret;
  if (input.providerIntent !== undefined) patch.provider_intent = input.providerIntent;
  if (input.settledAt !== undefined) patch.settled_at = input.settledAt;
  if (input.settlementTxRef !== undefined) patch.settlement_tx_ref = input.settlementTxRef;
  if (input.settlementProof !== undefined) patch.settlement_proof = input.settlementProof;
  if (input.expiresAt !== undefined) patch.expires_at = input.expiresAt;
  if (input.metadata !== undefined) patch.metadata = input.metadata;
  return patch;
}

function toDomain(row: PaymentRequestDbRow): PaymentRequestRow {
  return {
    id: row.id,
    organizationId: row.organization_id,
    agentId: row.agent_id,
    appId: row.app_id,
    provider: row.provider,
    amountCents: Number(row.amount_cents),
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

  async updatePaymentRequestStatus(
    id: string,
    status: PaymentRequestStatus | null,
    patch: Partial<NewPaymentRequest> = {},
  ): Promise<PaymentRequestRow | null> {
    const dbPatch = toDbPatch(patch);
    const [row] = await db
      .update(paymentRequests)
      .set({ ...dbPatch, ...(status ? { status } : {}), updated_at: new Date() })
      .where(eq(paymentRequests.id, id))
      .returning();
    return row ? toDomain(row) : null;
  }

  async recordPaymentRequestEvent(input: NewPaymentRequestEvent): Promise<PaymentRequestEventRow> {
    const [row] = await db.insert(paymentRequestEvents).values(toDbEvent(input)).returning();
    return row;
  }

  async expirePastPaymentRequests(now: Date): Promise<string[]> {
    const expirable: PaymentRequestStatus[] = ["pending", "delivered"];
    const rows = await db
      .update(paymentRequests)
      .set({ status: "expired", updated_at: now })
      .where(and(inArray(paymentRequests.status, expirable), lt(paymentRequests.expires_at, now)))
      .returning({ id: paymentRequests.id });
    return rows.map((r) => r.id);
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
