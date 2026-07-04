// Persists affiliates records for cloud services through the shared DB boundary.
import { asc, eq, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../client";
import {
  type AffiliateCode,
  affiliateCodes,
  type NewAffiliateCode,
  type NewUserAffiliate,
  type UserAffiliate,
  userAffiliates,
} from "../schemas/affiliates";

export class AffiliatesRepository {
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
