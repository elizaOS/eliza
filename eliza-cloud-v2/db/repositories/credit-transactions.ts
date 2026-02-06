import { eq, desc, and } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  creditTransactions,
  type CreditTransaction,
  type NewCreditTransaction,
} from "../schemas/credit-transactions";

export type { CreditTransaction, NewCreditTransaction };

/**
 * Repository for credit transaction database operations.
 *
 * Read operations → dbRead (read replica)
 * Write operations → dbWrite (NA primary)
 */
export class CreditTransactionsRepository {
  // ============================================================================
  // READ OPERATIONS (use read replica)
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
  async findByStripePaymentIntent(
    paymentIntentId: string,
  ): Promise<CreditTransaction | undefined> {
    return await dbRead.query.creditTransactions.findFirst({
      where: eq(creditTransactions.stripe_payment_intent_id, paymentIntentId),
    });
  }

  /**
   * Lists credit transactions for an organization, ordered by creation date.
   */
  async listByOrganization(
    organizationId: string,
    limit?: number,
  ): Promise<CreditTransaction[]> {
    return await dbRead.query.creditTransactions.findMany({
      where: eq(creditTransactions.organization_id, organizationId),
      orderBy: desc(creditTransactions.created_at),
      limit,
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

  // ============================================================================
  // WRITE OPERATIONS (use NA primary)
  // ============================================================================

  /**
   * Creates a new credit transaction.
   */
  async create(data: NewCreditTransaction): Promise<CreditTransaction> {
    const [transaction] = await dbWrite
      .insert(creditTransactions)
      .values(data)
      .returning();
    return transaction;
  }
}

/**
 * Singleton instance of CreditTransactionsRepository.
 */
export const creditTransactionsRepository = new CreditTransactionsRepository();
