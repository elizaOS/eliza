/** Persists affiliate records through primary and replica-aware cloud DB boundaries. */
import { and, asc, eq, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../client";
import {
  type AffiliateCode,
  affiliateCodes,
  type NewAffiliateCode,
  type NewUserAffiliate,
  type UserAffiliate,
  userAffiliates,
} from "../schemas/affiliates";
import { organizations } from "../schemas/organizations";
import { users } from "../schemas/users";

export class AffiliatesRepository {
  /**
   * Resolves billing attribution from the primary database at charge creation.
   * Replica or cached affiliate state must not determine a customer surcharge.
   */
  async getBillingAttributionForOrganization(organizationId: string): Promise<{
    userId: string | null;
    affiliateCode: AffiliateCode | null;
  }> {
    const [organization] = await dbWrite
      .select({ billingEmail: organizations.billing_email })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!organization) return { userId: null, affiliateCode: null };

    const organizationUsers = await dbWrite
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.organization_id, organizationId))
      .orderBy(asc(users.created_at), asc(users.id));
    const billingUser = organization.billingEmail
      ? organizationUsers.find((user) => user.email === organization.billingEmail)
      : undefined;
    const userId = billingUser?.id ?? organizationUsers[0]?.id ?? null;
    if (!userId) return { userId: null, affiliateCode: null };

    const [affiliate] = await dbWrite
      .select({ code: affiliateCodes })
      .from(userAffiliates)
      .innerJoin(
        affiliateCodes,
        and(
          eq(affiliateCodes.id, userAffiliates.affiliate_code_id),
          eq(affiliateCodes.is_active, true),
        ),
      )
      .where(eq(userAffiliates.user_id, userId))
      .limit(1);

    return { userId, affiliateCode: affiliate?.code ?? null };
  }

  async createAffiliateCode(data: NewAffiliateCode): Promise<AffiliateCode> {
    const result = await dbWrite.insert(affiliateCodes).values(data).returning();
    return result[0];
  }

  async createAffiliateCodeIfNotExists(data: NewAffiliateCode): Promise<AffiliateCode | null> {
    return await dbWrite.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`affiliate_code:${data.user_id}`}))`,
      );

      const [existing] = await tx
        .select()
        .from(affiliateCodes)
        .where(eq(affiliateCodes.user_id, data.user_id))
        .orderBy(asc(affiliateCodes.created_at))
        .limit(1);

      if (existing) {
        return existing;
      }

      const [created] = await tx.insert(affiliateCodes).values(data).returning();

      return created ?? null;
    });
  }

  async updateAffiliateCode(
    id: string,
    data: Partial<AffiliateCode>,
  ): Promise<AffiliateCode | null> {
    const result = await dbWrite
      .update(affiliateCodes)
      .set({ ...data, updated_at: new Date() })
      .where(eq(affiliateCodes.id, id))
      .returning();
    return result[0] || null;
  }

  async getAffiliateCodeByUserId(userId: string): Promise<AffiliateCode | null> {
    const [result] = await dbRead
      .select()
      .from(affiliateCodes)
      .where(eq(affiliateCodes.user_id, userId))
      .orderBy(asc(affiliateCodes.created_at))
      .limit(1);
    return result ?? null;
  }

  async getAffiliateCodeByCode(code: string): Promise<AffiliateCode | null> {
    const result = await dbRead.query.affiliateCodes.findFirst({
      where: eq(affiliateCodes.code, code),
    });
    return result || null;
  }

  async getAffiliateCodeById(id: string): Promise<AffiliateCode | null> {
    const result = await dbRead.query.affiliateCodes.findFirst({
      where: eq(affiliateCodes.id, id),
    });
    return result || null;
  }

  async linkUserToAffiliate(data: NewUserAffiliate): Promise<UserAffiliate> {
    const result = await dbWrite.insert(userAffiliates).values(data).returning();
    return result[0];
  }

  async getUserAffiliate(userId: string): Promise<UserAffiliate | null> {
    const result = await dbRead.query.userAffiliates.findFirst({
      where: eq(userAffiliates.user_id, userId),
    });
    return result || null;
  }
}

export const affiliatesRepository = new AffiliatesRepository();
