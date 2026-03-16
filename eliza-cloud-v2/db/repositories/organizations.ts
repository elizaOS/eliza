import { eq } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  organizations,
  type Organization,
  type NewOrganization,
} from "../schemas/organizations";
import { creditTransactions } from "../schemas/credit-transactions";
import type { CreditTransaction } from "../schemas/credit-transactions";

export type { Organization, NewOrganization };

/**
 * Repository for organization database operations.
 *
 * Read operations → dbRead (read replica)
 * Write operations → dbWrite (NA primary)
 */
export class OrganizationsRepository {
  // ============================================================================
  // READ OPERATIONS (use read replica)
  // ============================================================================

  /**
   * Finds an organization by ID.
   */
  async findById(id: string): Promise<Organization | undefined> {
    return await dbRead.query.organizations.findFirst({
      where: eq(organizations.id, id),
    });
  }

  /**
   * Finds an organization by slug.
   */
  async findBySlug(slug: string): Promise<Organization | undefined> {
    return await dbRead.query.organizations.findFirst({
      where: eq(organizations.slug, slug),
    });
  }

  /**
   * Finds an organization by Stripe customer ID.
   */
  async findByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<Organization | undefined> {
    return await dbRead.query.organizations.findFirst({
      where: eq(organizations.stripe_customer_id, stripeCustomerId),
    });
  }

  /**
   * Finds an organization with associated users.
   */
  async findWithUsers(id: string) {
    return await dbRead.query.organizations.findFirst({
      where: eq(organizations.id, id),
      with: {
        users: true,
      },
    });
  }

  // ============================================================================
  // WRITE OPERATIONS (use NA primary)
  // ============================================================================

  /**
   * Creates a new organization.
   */
  async create(data: NewOrganization): Promise<Organization> {
    const [organization] = await dbWrite
      .insert(organizations)
      .values(data)
      .returning();
    return organization;
  }

  /**
   * Updates an existing organization.
   */
  async update(
    id: string,
    data: Partial<NewOrganization>,
  ): Promise<Organization | undefined> {
    const [updated] = await dbWrite
      .update(organizations)
      .set({
        ...data,
        updated_at: new Date(),
      })
      .where(eq(organizations.id, id))
      .returning();
    return updated;
  }

  /**
   * Updates organization credit balance atomically.
   *
   * @throws Error if organization not found or balance would go negative.
   */
  async updateCreditBalance(
    organizationId: string,
    amount: number,
  ): Promise<{ success: boolean; newBalance: number }> {
    const result = await dbWrite.transaction(async (tx) => {
      const org = await tx.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
      });

      if (!org) {
        throw new Error("Organization not found");
      }

      const currentBalance = Number(org.credit_balance);
      const newBalance = currentBalance + amount;

      if (newBalance < 0) {
        throw new Error("Insufficient balance");
      }

      await tx
        .update(organizations)
        .set({
          credit_balance: String(newBalance),
          updated_at: new Date(),
        })
        .where(eq(organizations.id, organizationId));

      return { success: true, newBalance };
    });

    return result;
  }

  /**
   * Deletes an organization by ID.
   */
  async delete(id: string): Promise<void> {
    await dbWrite.delete(organizations).where(eq(organizations.id, id));
  }

  /**
   * Deducts credits from organization balance and creates a transaction record.
   *
   * Performs both operations atomically in a transaction.
   *
   * @throws Error if organization not found or insufficient balance.
   */
  async deductCreditsWithTransaction(
    organizationId: string,
    amount: number,
    description: string,
    userId?: string,
  ): Promise<{
    success: boolean;
    newBalance: number;
    transaction: CreditTransaction;
  }> {
    return await dbWrite.transaction(async (tx) => {
      const org = await tx.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
      });

      if (!org) {
        throw new Error("Organization not found");
      }

      const currentBalance = Number(org.credit_balance);

      if (currentBalance < amount) {
        throw new Error(
          `Insufficient balance. Required: $${amount.toFixed(2)}, Available: $${currentBalance.toFixed(2)}`,
        );
      }

      const newBalance = currentBalance - amount;

      await tx
        .update(organizations)
        .set({
          credit_balance: String(newBalance),
          updated_at: new Date(),
        })
        .where(eq(organizations.id, organizationId));

      const [creditTx] = await tx
        .insert(creditTransactions)
        .values({
          organization_id: organizationId,
          user_id: userId || null,
          amount: String(-amount),
          type: "debit",
          description,
          created_at: new Date(),
        })
        .returning();

      return { success: true, newBalance, transaction: creditTx };
    });
  }
}

/**
 * Singleton instance of OrganizationsRepository.
 */
export const organizationsRepository = new OrganizationsRepository();
