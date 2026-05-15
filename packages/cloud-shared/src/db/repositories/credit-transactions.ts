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
