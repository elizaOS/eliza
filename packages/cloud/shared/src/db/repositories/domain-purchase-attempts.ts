/**
 * Persists the tenant-scoped domain-purchase state machine around credit and registrar side effects.
 *
 * Every transition is compare-and-set on the write database. The registrar call
 * may happen only after a durable provider lease is acquired; retries reconcile
 * an expired lease instead of deleting the row or repeating the external call.
 */

import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import { dbWrite } from "../client";
import {
  type DomainPurchaseIdempotency,
  domainPurchaseIdempotency,
} from "../schemas/domain-purchase-idempotency";

export type DomainPurchaseAttemptStatus =
  | "processing"
  | "quoted"
  | "charged"
  | "provider_started"
  | "provider_ambiguous"
  | "registered"
  | "completed"
  | "refund_pending"
  | "refunded"
  | "failed";

export interface DomainPurchaseQuote {
  totalUsdCents: number;
  wholesaleUsdCents: number;
  marginUsdCents: number;
  registrationWholesaleUsdCents: number;
  renewalWholesaleUsdCents: number;
  renewalUsdCents: number;
  years: number;
  currency: "USD";
}

export interface CreateDomainPurchaseAttemptInput {
  key: string;
  organizationId: string;
  appId: string;
  domain: string;
  requestDigest: string;
  registrationYears: number;
  expiresAt: Date;
}

function assertAttempt(row: DomainPurchaseIdempotency | undefined): DomainPurchaseIdempotency {
  if (!row) throw new Error("Domain purchase attempt transition lost its row");
  return row;
}

class DomainPurchaseAttemptsRepository {
  async read(key: string): Promise<DomainPurchaseIdempotency | null> {
    const [row] = await dbWrite
      .select()
      .from(domainPurchaseIdempotency)
      .where(eq(domainPurchaseIdempotency.key, key))
      .limit(1);
    return row ?? null;
  }

  async deleteExpiredLegacyUncharged(input: {
    key: string;
    organizationId: string;
    now: Date;
  }): Promise<boolean> {
    const deleted = await dbWrite
      .delete(domainPurchaseIdempotency)
      .where(
        and(
          eq(domainPurchaseIdempotency.key, input.key),
          eq(domainPurchaseIdempotency.organization_id, input.organizationId),
          sql`${domainPurchaseIdempotency.request_digest} IS NULL`,
          sql`${domainPurchaseIdempotency.charge_id} IS NULL`,
          sql`${domainPurchaseIdempotency.response_body} IS NULL`,
          lte(domainPurchaseIdempotency.expires_at, input.now),
          sql`NOT EXISTS (
            SELECT 1
            FROM (
              SELECT
                count(*) FILTER (
                  WHERE ledger.metadata->>'type' = 'domain_purchase'
                ) AS debits,
                count(*) FILTER (
                  WHERE ledger.metadata->>'type' = 'domain_purchase_refund'
                ) AS refunds
              FROM credit_transactions AS ledger
              WHERE ledger.organization_id = ${domainPurchaseIdempotency.organization_id}
                AND ledger.metadata->>'domain' = ${domainPurchaseIdempotency.domain}
            ) AS legacy_balance
            WHERE legacy_balance.debits > legacy_balance.refunds
          )`,
        ),
      )
      .returning({ id: domainPurchaseIdempotency.id });
    return deleted.length === 1;
  }

  async createOrRead(
    input: CreateDomainPurchaseAttemptInput,
  ): Promise<{ attempt: DomainPurchaseIdempotency; created: boolean }> {
    const [created] = await dbWrite
      .insert(domainPurchaseIdempotency)
      .values({
        key: input.key,
        organization_id: input.organizationId,
        app_id: input.appId,
        domain: input.domain,
        request_digest: input.requestDigest,
        registration_years: input.registrationYears,
        status: "processing",
        expires_at: input.expiresAt,
      })
      .onConflictDoNothing({ target: domainPurchaseIdempotency.key })
      .returning();
    if (created) return { attempt: created, created: true };

    const [existing] = await dbWrite
      .select()
      .from(domainPurchaseIdempotency)
      .where(eq(domainPurchaseIdempotency.key, input.key))
      .limit(1);
    return { attempt: assertAttempt(existing), created: false };
  }

  async storeQuote(input: {
    key: string;
    organizationId: string;
    requestDigest: string;
    quote: DomainPurchaseQuote;
    expiresAt: Date;
  }): Promise<DomainPurchaseIdempotency> {
    const [updated] = await dbWrite
      .update(domainPurchaseIdempotency)
      .set({
        status: "quoted",
        charge: { ...input.quote },
        expires_at: input.expiresAt,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(domainPurchaseIdempotency.key, input.key),
          eq(domainPurchaseIdempotency.organization_id, input.organizationId),
          eq(domainPurchaseIdempotency.request_digest, input.requestDigest),
          inArray(domainPurchaseIdempotency.status, ["processing", "quoted"]),
          sql`(
            ${domainPurchaseIdempotency.charge} IS NULL
            OR ${domainPurchaseIdempotency.charge} = ${JSON.stringify(input.quote)}::jsonb
          )`,
        ),
      )
      .returning();
    return assertAttempt(updated);
  }

  async attachCharge(input: {
    key: string;
    organizationId: string;
    requestDigest: string;
    chargeId: string;
  }): Promise<DomainPurchaseIdempotency> {
    const [updated] = await dbWrite
      .update(domainPurchaseIdempotency)
      .set({
        status: "charged",
        charge_id: input.chargeId,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(domainPurchaseIdempotency.key, input.key),
          eq(domainPurchaseIdempotency.organization_id, input.organizationId),
          eq(domainPurchaseIdempotency.request_digest, input.requestDigest),
          inArray(domainPurchaseIdempotency.status, ["quoted", "charged"]),
          sql`(${domainPurchaseIdempotency.charge_id} IS NULL OR ${domainPurchaseIdempotency.charge_id} = ${input.chargeId})`,
        ),
      )
      .returning();
    return assertAttempt(updated);
  }

  async claimRegistrarStart(input: {
    key: string;
    organizationId: string;
    leaseToken: string;
    claimedUntil: Date;
  }): Promise<DomainPurchaseIdempotency | null> {
    const [updated] = await dbWrite
      .update(domainPurchaseIdempotency)
      .set({
        status: "provider_started",
        lease_token: input.leaseToken,
        provider_started_at: new Date(),
        expires_at: input.claimedUntil,
        next_reconcile_at: input.claimedUntil,
        attempt_count: sql`${domainPurchaseIdempotency.attempt_count} + 1`,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(domainPurchaseIdempotency.key, input.key),
          eq(domainPurchaseIdempotency.organization_id, input.organizationId),
          eq(domainPurchaseIdempotency.status, "charged"),
          sql`${domainPurchaseIdempotency.charge_id} IS NOT NULL`,
        ),
      )
      .returning();
    return updated ?? null;
  }

  async claimReconciliation(input: {
    key: string;
    organizationId: string;
    leaseToken: string;
    now: Date;
    claimedUntil: Date;
  }): Promise<DomainPurchaseIdempotency | null> {
    const [updated] = await dbWrite
      .update(domainPurchaseIdempotency)
      .set({
        status: "provider_ambiguous",
        lease_token: input.leaseToken,
        expires_at: input.claimedUntil,
        next_reconcile_at: input.claimedUntil,
        attempt_count: sql`${domainPurchaseIdempotency.attempt_count} + 1`,
        updated_at: input.now,
      })
      .where(
        and(
          eq(domainPurchaseIdempotency.key, input.key),
          eq(domainPurchaseIdempotency.organization_id, input.organizationId),
          inArray(domainPurchaseIdempotency.status, ["provider_started", "provider_ambiguous"]),
          lte(domainPurchaseIdempotency.expires_at, input.now),
        ),
      )
      .returning();
    return updated ?? null;
  }

  async listDueReconciliation(input: {
    now: Date;
    limit: number;
  }): Promise<DomainPurchaseIdempotency[]> {
    return dbWrite
      .select()
      .from(domainPurchaseIdempotency)
      .where(
        and(
          inArray(domainPurchaseIdempotency.status, [
            "charged",
            "provider_started",
            "provider_ambiguous",
            "refund_pending",
            "registered",
          ]),
          or(
            lte(domainPurchaseIdempotency.next_reconcile_at, input.now),
            lte(domainPurchaseIdempotency.expires_at, input.now),
          ),
        ),
      )
      .orderBy(domainPurchaseIdempotency.expires_at)
      .limit(Math.max(1, Math.min(input.limit, 100)));
  }

  async markProviderAmbiguous(input: {
    key: string;
    organizationId: string;
    leaseToken: string;
    errorCode: string;
    nextReconcileAt: Date;
  }): Promise<DomainPurchaseIdempotency> {
    const [updated] = await dbWrite
      .update(domainPurchaseIdempotency)
      .set({
        status: "provider_ambiguous",
        error_code: input.errorCode,
        expires_at: input.nextReconcileAt,
        next_reconcile_at: input.nextReconcileAt,
        lease_token: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(domainPurchaseIdempotency.key, input.key),
          eq(domainPurchaseIdempotency.organization_id, input.organizationId),
          eq(domainPurchaseIdempotency.lease_token, input.leaseToken),
          inArray(domainPurchaseIdempotency.status, ["provider_started", "provider_ambiguous"]),
        ),
      )
      .returning();
    return assertAttempt(updated);
  }

  async markRegistered(input: {
    key: string;
    organizationId: string;
    leaseToken: string;
    registrationId: string;
  }): Promise<DomainPurchaseIdempotency> {
    const [updated] = await dbWrite
      .update(domainPurchaseIdempotency)
      .set({
        status: "registered",
        cloudflare_registration_id: input.registrationId,
        lease_token: null,
        error_code: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(domainPurchaseIdempotency.key, input.key),
          eq(domainPurchaseIdempotency.organization_id, input.organizationId),
          eq(domainPurchaseIdempotency.lease_token, input.leaseToken),
          inArray(domainPurchaseIdempotency.status, ["provider_started", "provider_ambiguous"]),
        ),
      )
      .returning();
    return assertAttempt(updated);
  }

  async markRefundPending(input: {
    key: string;
    organizationId: string;
    leaseToken: string;
    errorCode: string;
  }): Promise<DomainPurchaseIdempotency> {
    const [updated] = await dbWrite
      .update(domainPurchaseIdempotency)
      .set({
        status: "refund_pending",
        error_code: input.errorCode,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(domainPurchaseIdempotency.key, input.key),
          eq(domainPurchaseIdempotency.organization_id, input.organizationId),
          eq(domainPurchaseIdempotency.lease_token, input.leaseToken),
          inArray(domainPurchaseIdempotency.status, ["provider_started", "provider_ambiguous"]),
        ),
      )
      .returning();
    return assertAttempt(updated);
  }

  async markChargedRefundPending(input: {
    key: string;
    organizationId: string;
    errorCode: string;
  }): Promise<DomainPurchaseIdempotency> {
    const [updated] = await dbWrite
      .update(domainPurchaseIdempotency)
      .set({
        status: "refund_pending",
        error_code: input.errorCode,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(domainPurchaseIdempotency.key, input.key),
          eq(domainPurchaseIdempotency.organization_id, input.organizationId),
          eq(domainPurchaseIdempotency.status, "charged"),
          sql`${domainPurchaseIdempotency.provider_started_at} IS NULL`,
          sql`${domainPurchaseIdempotency.charge_id} IS NOT NULL`,
        ),
      )
      .returning();
    return assertAttempt(updated);
  }

  async markTerminalFailure(input: {
    key: string;
    organizationId: string;
    errorCode: string;
    responseStatus: number;
    responseBody: Record<string, unknown>;
    replayUntil: Date;
  }): Promise<DomainPurchaseIdempotency> {
    const [updated] = await dbWrite
      .update(domainPurchaseIdempotency)
      .set({
        status: "failed",
        error_code: input.errorCode,
        response_status: input.responseStatus,
        response_body: input.responseBody,
        lease_token: null,
        expires_at: input.replayUntil,
        next_reconcile_at: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(domainPurchaseIdempotency.key, input.key),
          eq(domainPurchaseIdempotency.organization_id, input.organizationId),
          inArray(domainPurchaseIdempotency.status, ["processing", "quoted", "failed"]),
          sql`${domainPurchaseIdempotency.charge_id} IS NULL`,
        ),
      )
      .returning();
    return assertAttempt(updated);
  }

  async markRefunded(input: {
    key: string;
    organizationId: string;
    refundId: string;
    responseStatus: number;
    responseBody: Record<string, unknown>;
    replayUntil: Date;
  }): Promise<DomainPurchaseIdempotency> {
    const [updated] = await dbWrite
      .update(domainPurchaseIdempotency)
      .set({
        status: "refunded",
        refund_id: input.refundId,
        response_status: input.responseStatus,
        response_body: input.responseBody,
        lease_token: null,
        expires_at: input.replayUntil,
        next_reconcile_at: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(domainPurchaseIdempotency.key, input.key),
          eq(domainPurchaseIdempotency.organization_id, input.organizationId),
          inArray(domainPurchaseIdempotency.status, ["refund_pending", "refunded"]),
          sql`(${domainPurchaseIdempotency.refund_id} IS NULL OR ${domainPurchaseIdempotency.refund_id} = ${input.refundId})`,
        ),
      )
      .returning();
    return assertAttempt(updated);
  }

  async complete(input: {
    key: string;
    organizationId: string;
    managedDomainId: string;
    responseStatus: number;
    responseBody: Record<string, unknown>;
    replayUntil: Date;
  }): Promise<DomainPurchaseIdempotency> {
    const [updated] = await dbWrite
      .update(domainPurchaseIdempotency)
      .set({
        status: "completed",
        managed_domain_id: input.managedDomainId,
        response_status: input.responseStatus,
        response_body: input.responseBody,
        lease_token: null,
        expires_at: input.replayUntil,
        next_reconcile_at: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(domainPurchaseIdempotency.key, input.key),
          eq(domainPurchaseIdempotency.organization_id, input.organizationId),
          inArray(domainPurchaseIdempotency.status, [
            "processing",
            "quoted",
            "charged",
            "provider_started",
            "provider_ambiguous",
            "registered",
            "completed",
          ]),
        ),
      )
      .returning();
    return assertAttempt(updated);
  }
}

export const domainPurchaseAttemptsRepository = new DomainPurchaseAttemptsRepository();
