// Persists credit transactions records for cloud services through the shared DB boundary.
import { and, desc, eq, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type CreditTransaction,
  creditTransactions,
  type NewCreditTransaction,
} from "../schemas/credit-transactions";

export type { CreditTransaction, NewCreditTransaction };

/**
 * Repository for credit transaction database operations.
 *
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
 */
export class CreditTransactionsRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Finds a credit transaction by ID.
   */
  async findById(id: string): Promise<CreditTransaction | undefined> {
    return await dbRead.query.creditTransactions.findFirst({
      where: eq(creditTransactions.id, id),
    });
  }

  /**
   * Finds a credit transaction by Stripe payment intent ID.
   */
  async findByStripePaymentIntent(paymentIntentId: string): Promise<CreditTransaction | undefined> {
    return await dbRead.query.creditTransactions.findFirst({
      where: eq(creditTransactions.stripe_payment_intent_id, paymentIntentId),
    });
  }

  /**
   * Lists credit transactions for an organization, ordered by creation date.
   * Always bounded — `limit` defaults to 50 and is clamped to [1, 200].
   */
  async listByOrganization(organizationId: string, limit?: number): Promise<CreditTransaction[]> {
    const boundedLimit = Math.min(Math.max(limit ?? 50, 1), 200);
    return await dbRead.query.creditTransactions.findMany({
      where: eq(creditTransactions.organization_id, organizationId),
      orderBy: desc(creditTransactions.created_at),
      limit: boundedLimit,
    });
  }

  /**
   * Lists credit transactions for an organization filtered by type.
   */
  async listByOrganizationAndType(
    organizationId: string,
    type: string,
  ): Promise<CreditTransaction[]> {
    return await dbRead.query.creditTransactions.findMany({
      where: and(
        eq(creditTransactions.organization_id, organizationId),
        eq(creditTransactions.type, type),
      ),
      orderBy: desc(creditTransactions.created_at),
    });
  }

  /**
   * Returns true if the organization has already received a signup code bonus.
   * WHY dbWrite (primary): On redeem, use a primary read to avoid granting twice.
   */
  async hasSignupCodeBonus(organizationId: string): Promise<boolean> {
    const [row] = await dbWrite
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.organization_id, organizationId),
          eq(creditTransactions.type, "credit"),
          sql`${creditTransactions.metadata}->>'type' = 'signup_code_bonus'`,
        ),
      )
      .limit(1);
    return !!row;
  }

  /**
   * Returns true if the organization has already received the Eliza App
   * starter credits. WHY dbWrite (primary): onboarding provisioning can call
   * this immediately before crediting, so avoid stale read replicas.
   */
  async hasElizaAppInitialFreeCredits(organizationId: string): Promise<boolean> {
    const [row] = await dbWrite
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.organization_id, organizationId),
          eq(creditTransactions.type, "credit"),
          sql`${creditTransactions.metadata}->>'type' = 'initial_free_credits'`,
        ),
      )
      .limit(1);
    return !!row;
  }

  /**
   * Returns true if the organization has a `domain_purchase` debit for this
   * domain that has NOT been fully refunded (debits outnumber refunds).
   *
   * This is the ownership proof for recovering an already-registered domain
   * that has no `managed_domains` row (the orphan left when the post-register
   * persist fails). Only the org that actually paid — and was not refunded —
   * may re-claim such a domain without a fresh debit; any other org is denied,
   * closing the cross-tenant free-domain takeover (#10253).
   *
   * WHY dbWrite (primary): the buy flow calls this right after writing the debit
   * row, so it must not race a stale read replica.
   */
  async hasUnrefundedDomainPurchase(organizationId: string, domain: string): Promise<boolean> {
    const [row] = await dbWrite
      .select({
        debits: sql<number>`count(*) filter (where ${creditTransactions.metadata}->>'type' = 'domain_purchase')`,
        refunds: sql<number>`count(*) filter (where ${creditTransactions.metadata}->>'type' = 'domain_purchase_refund')`,
      })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.organization_id, organizationId),
          sql`${creditTransactions.metadata}->>'domain' = ${domain}`,
        ),
      );
    return Number(row?.debits ?? 0) > Number(row?.refunds ?? 0);
  }

  /**
   * Returns true if the org has already been successfully charged for renewing
   * `domain` for the given `renewalPeriod` (a `domain_renewal` debit for that
   * exact period that was not refunded). The renewal cron checks this BEFORE
   * debiting so a re-run within the renewal window cannot double-charge a
   * domain for the same period (idempotent per (domain, period)).
   *
   * WHY dbWrite (primary): the cron debits immediately after this check.
   */
  async hasUnrefundedDomainRenewal(
    organizationId: string,
    domain: string,
    renewalPeriod: string,
  ): Promise<boolean> {
    const [row] = await dbWrite
      .select({
        debits: sql<number>`count(*) filter (where ${creditTransactions.metadata}->>'type' = 'domain_renewal')`,
        refunds: sql<number>`count(*) filter (where ${creditTransactions.metadata}->>'type' = 'domain_renewal_refund')`,
      })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.organization_id, organizationId),
          sql`${creditTransactions.metadata}->>'domain' = ${domain}`,
          sql`${creditTransactions.metadata}->>'renewalPeriod' = ${renewalPeriod}`,
        ),
      );
    return Number(row?.debits ?? 0) > Number(row?.refunds ?? 0);
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new credit transaction.
   */
  async create(data: NewCreditTransaction): Promise<CreditTransaction> {
    const [transaction] = await dbWrite.insert(creditTransactions).values(data).returning();
    return transaction;
  }
}

/**
 * Singleton instance of CreditTransactionsRepository.
 */
export const creditTransactionsRepository = new CreditTransactionsRepository();
