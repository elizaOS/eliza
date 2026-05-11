import { and, desc, eq, gte, lte, lt, inArray, sql } from "drizzle-orm";
import { dbWrite as db } from "@/db/client";
import {
  type NewPaymentRequest,
  type NewPaymentRequestEvent,
  type PaymentRequestEventRow,
  type PaymentRequestProvider,
  type PaymentRequestRow,
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

class PaymentRequestsRepository {
  async createPaymentRequest(input: NewPaymentRequest): Promise<PaymentRequestRow> {
    const [row] = await db.insert(paymentRequests).values(input).returning();
    return row;
  }

  async getPaymentRequest(id: string): Promise<PaymentRequestRow | null> {
    const [row] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, id))
      .limit(1);
    return row ?? null;
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

    return db
      .select()
      .from(paymentRequests)
      .where(and(...conditions))
      .orderBy(desc(paymentRequests.created_at))
      .limit(limit)
      .offset(offset);
  }

  async updatePaymentRequestStatus(
    id: string,
    status: PaymentRequestStatus,
    patch: Partial<NewPaymentRequest> = {},
  ): Promise<PaymentRequestRow | null> {
    const [row] = await db
      .update(paymentRequests)
      .set({ ...patch, status, updated_at: new Date() })
      .where(eq(paymentRequests.id, id))
      .returning();
    return row ?? null;
  }

  async recordPaymentRequestEvent(
    input: NewPaymentRequestEvent,
  ): Promise<PaymentRequestEventRow> {
    const [row] = await db.insert(paymentRequestEvents).values(input).returning();
    return row;
  }

  async expirePastPaymentRequests(now: Date): Promise<string[]> {
    const expirable: PaymentRequestStatus[] = ["pending", "delivered"];
    const rows = await db
      .update(paymentRequests)
      .set({ status: "expired", updated_at: now })
      .where(
        and(
          inArray(paymentRequests.status, expirable),
          lt(paymentRequests.expires_at, now),
        ),
      )
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
    return row ?? null;
  }
}

export const paymentRequestsRepository = new PaymentRequestsRepository();

export type {
  NewPaymentRequest,
  NewPaymentRequestEvent,
  PaymentRequestEventRow,
  PaymentRequestProvider,
  PaymentRequestRow,
  PaymentRequestStatus,
};
