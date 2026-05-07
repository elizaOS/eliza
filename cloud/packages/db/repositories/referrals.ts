import { and, desc, eq, gte, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/helpers";
import {
  type NewReferralCode,
  type NewReferralSignup,
  type NewSocialShareReward,
  type ReferralCode,
  type ReferralSignup,
  referralCodes,
  referralSignups,
  type SocialShareReward,
  socialShareRewards,
} from "@/db/schemas/referrals";

/**
 * Repository for referral code database operations.
 */
class ReferralCodesRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Finds a referral code by ID.
   */
  async findById(id: string): Promise<ReferralCode | null> {
    const [result] = await dbRead
      .select()
      .from(referralCodes)
      .where(eq(referralCodes.id, id))
      .limit(1);
    return result || null;
  }

  /**
   * Finds a referral code by user ID.
   */
  async findByUserId(userId: string): Promise<ReferralCode | null> {
    const [result] = await dbRead
      .select()
      .from(referralCodes)
      .where(eq(referralCodes.user_id, userId))
      .limit(1);
    return result || null;
  }

  /**
   * Finds a referral code by code string (case-insensitive, converted to uppercase).
   */
  async findByCode(code: string): Promise<ReferralCode | null> {
    const [result] = await dbRead
      .select()
      .from(referralCodes)
      .where(eq(referralCodes.code, code.toUpperCase()))
      .limit(1);
    return result || null;
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new referral code.
   */
  async create(data: NewReferralCode): Promise<ReferralCode> {
    const [result] = await dbWrite.insert(referralCodes).values(data).returning();
    return result;
  }

  /**
   * Atomically increments the referral count for a code.
   */
  async incrementReferrals(id: string): Promise<void> {
    await dbWrite
      .update(referralCodes)
      .set({
        total_referrals: sql`${referralCodes.total_referrals} + 1`,
      })
      .where(eq(referralCodes.id, id));
  }

  /**
   * Atomically adds signup earnings to a referral code.
   */
  async addSignupEarnings(id: string, amount: number): Promise<void> {
    await dbWrite
      .update(referralCodes)
      .set({
        total_signup_earnings: sql`${referralCodes.total_signup_earnings} + ${amount}`,
      })
      .where(eq(referralCodes.id, id));
  }

  /**
   * Atomically adds commission earnings to a referral code.
   */
  async addCommissionEarnings(id: string, amount: number): Promise<void> {
    await dbWrite
      .update(referralCodes)
      .set({
        total_commission_earnings: sql`${referralCodes.total_commission_earnings} + ${amount}`,
      })
      .where(eq(referralCodes.id, id));
  }

  /**
   * Atomically adds qualified referral earnings to a referral code.
   */
  async addQualifiedEarnings(id: string, amount: number): Promise<void> {
    await dbWrite
      .update(referralCodes)
      .set({
        total_qualified_earnings: sql`${referralCodes.total_qualified_earnings} + ${amount}`,
      })
      .where(eq(referralCodes.id, id));
  }
}

/**
 * Repository for referral signup database operations.
 */
class ReferralSignupsRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Finds a referral signup by ID.
   */
  async findById(id: string): Promise<ReferralSignup | null> {
    const [result] = await dbRead
      .select()
      .from(referralSignups)
      .where(eq(referralSignups.id, id))
      .limit(1);
    return result || null;
  }

  /**
   * Finds a referral signup by referred user ID.
   */
  async findByReferredUserId(userId: string): Promise<ReferralSignup | null> {
    const [result] = await dbRead
      .select()
      .from(referralSignups)
      .where(eq(referralSignups.referred_user_id, userId))
      .limit(1);
    return result || null;
  }

  /**
   * Lists referral signups for a referrer, ordered by creation date.
   */
  async listByReferrerId(referrerId: string, limit = 50): Promise<ReferralSignup[]> {
    return dbRead
      .select()
      .from(referralSignups)
      .where(eq(referralSignups.referrer_user_id, referrerId))
      .orderBy(desc(referralSignups.created_at))
      .limit(limit);
  }

  /**
   * Finds an unqualified referral signup for a user.
   */
  async findUnqualifiedByReferredUserId(userId: string): Promise<ReferralSignup | null> {
    const [result] = await dbRead
      .select()
      .from(referralSignups)
      .where(
        and(
          eq(referralSignups.referred_user_id, userId),
          sql`${referralSignups.qualified_at} IS NULL`,
        ),
      )
      .limit(1);
    return result || null;
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new referral signup record.
   */
  async create(data: NewReferralSignup): Promise<ReferralSignup> {
    const [result] = await dbWrite.insert(referralSignups).values(data).returning();
    return result;
  }

  /**
   * Marks signup bonus as credited for a referral signup.
   */
  async markBonusCredited(id: string, amount: number): Promise<ReferralSignup | null> {
    const [result] = await dbWrite
      .update(referralSignups)
      .set({
        signup_bonus_credited: true,
        signup_bonus_amount: String(amount),
      })
      .where(eq(referralSignups.id, id))
      .returning();
    return result || null;
  }

  /**
   * Atomically adds commission earnings to a referral signup.
   */
  async addCommission(id: string, amount: number): Promise<void> {
    await dbWrite
      .update(referralSignups)
      .set({
        total_commission_earned: sql`${referralSignups.total_commission_earned} + ${amount}`,
      })
      .where(eq(referralSignups.id, id));
  }

  /**
   * Marks a referral as qualified and credits the qualified bonus.
   */
  async markQualified(id: string, amount: number): Promise<ReferralSignup | null> {
    const [result] = await dbWrite
      .update(referralSignups)
      .set({
        qualified_at: new Date(),
        qualified_bonus_credited: true,
        qualified_bonus_amount: String(amount),
      })
      .where(and(eq(referralSignups.id, id), sql`${referralSignups.qualified_at} IS NULL`))
      .returning();
    return result || null;
  }
}

/**
 * Repository for social share reward database operations.
 */
class SocialShareRewardsRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Lists social share rewards for a user, ordered by creation date.
   */
  async listByUserId(userId: string, limit = 50): Promise<SocialShareReward[]> {
    return dbRead
      .select()
      .from(socialShareRewards)
      .where(eq(socialShareRewards.user_id, userId))
      .orderBy(desc(socialShareRewards.created_at))
      .limit(limit);
  }

  /**
   * Checks if user has claimed a reward for the specified platform today.
   */
  async hasClaimedToday(
    userId: string,
    platform: "x" | "farcaster" | "telegram" | "discord",
  ): Promise<boolean> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [result] = await dbRead
      .select()
      .from(socialShareRewards)
      .where(
        and(
          eq(socialShareRewards.user_id, userId),
          eq(socialShareRewards.platform, platform),
          gte(socialShareRewards.created_at, startOfDay),
        ),
      )
      .limit(1);

    return !!result;
  }

  /**
   * Gets total credits earned from social shares for a user.
   */
  async getTotalEarnings(userId: string): Promise<number> {
    const [result] = await dbRead
      .select({
        total: sql<string>`COALESCE(SUM(${socialShareRewards.credits_awarded}), 0)`,
      })
      .from(socialShareRewards)
      .where(eq(socialShareRewards.user_id, userId));

    return Number(result?.total || 0);
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new social share reward record.
   */
  async create(data: NewSocialShareReward): Promise<SocialShareReward> {
    const [result] = await dbWrite
      .insert(socialShareRewards)
      .values({
        ...data,
        share_intent_at: new Date(),
      })
      .returning();
    return result;
  }

  /**
   * Atomically checks if user has claimed today and creates a new share record if not.
   * Prevents race conditions by doing check-and-insert in a single transaction.
   *
   * @returns The created share record, or null if already claimed today
   */
  async createIfNotClaimedToday(
    userId: string,
    platform: "x" | "farcaster" | "telegram" | "discord",
    data: Omit<NewSocialShareReward, "user_id" | "platform">,
  ): Promise<SocialShareReward | null> {
    return await dbWrite.transaction(async (tx) => {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      // Check inside transaction to prevent race conditions
      const [existing] = await tx
        .select()
        .from(socialShareRewards)
        .where(
          and(
            eq(socialShareRewards.user_id, userId),
            eq(socialShareRewards.platform, platform),
            gte(socialShareRewards.created_at, startOfDay),
          ),
        )
        .limit(1);

      if (existing) {
        return null; // Already claimed today
      }

      // Create the record
      const [result] = await tx
        .insert(socialShareRewards)
        .values({
          ...data,
          user_id: userId,
          platform,
          share_intent_at: new Date(),
        })
        .returning();

      return result;
    });
  }

  /**
   * Marks a social share reward as verified.
   */
  async markVerified(id: string): Promise<SocialShareReward | null> {
    const [result] = await dbWrite
      .update(socialShareRewards)
      .set({ verified: true })
      .where(eq(socialShareRewards.id, id))
      .returning();
    return result || null;
  }
}

/**
 * Singleton instance of ReferralCodesRepository.
 */
export const referralCodesRepository = new ReferralCodesRepository();

/**
 * Singleton instance of ReferralSignupsRepository.
 */
export const referralSignupsRepository = new ReferralSignupsRepository();

/**
 * Singleton instance of SocialShareRewardsRepository.
 */
export const socialShareRewardsRepository = new SocialShareRewardsRepository();

export type {
  NewReferralCode,
  NewReferralSignup,
  NewSocialShareReward,
  ReferralCode,
  ReferralSignup,
  SocialShareReward,
};
