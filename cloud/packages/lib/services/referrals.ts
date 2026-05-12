import * as crypto from "crypto";
import {
  type ReferralCode,
  type ReferralSignup,
  referralCodesRepository,
  referralSignupsRepository,
  type SocialShareReward,
  socialShareRewardsRepository,
} from "@/db/repositories/referrals";
import { usersRepository } from "@/db/repositories/users";
import { logger } from "@/lib/utils/logger";
import { appCreditsService } from "./app-credits";
import { creditsService } from "./credits";

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current && !seen.has(current)) {
    seen.add(current);

    if (current instanceof Error) {
      const code = Reflect.get(current, "code");
      if (code === "23505") {
        return true;
      }

      const message = current.message.toLowerCase();
      if (
        message.includes("unique constraint") ||
        message.includes("duplicate key value violates unique constraint")
      ) {
        return true;
      }

      current = Reflect.get(current, "cause");
      continue;
    }

    if (typeof current === "object") {
      const code = Reflect.get(current, "code");
      if (code === "23505") {
        return true;
      }
      current = Reflect.get(current, "cause");
      continue;
    }

    break;
  }

  return false;
}

/**
 * Referral and social share rewards service.
 *
 * WHY two concepts in one module: Referral codes drive signups and tie revenue to
 * a 50/40/10 split on purchase; social share rewards are also growth incentives
 * and share the same credit/org plumbing. Keeps all "growth reward" logic in one place.
 */

/**
 * Context for app-specific operations.
 * WHY appOwnerId/creatorId: When a user signs up via a miniapp or embed, we need to
 * attribute the 40% and 10% shares to the app owner and creator for calculateRevenueSplits.
 * When appId is set, referred-user bonus goes to app balance instead of org balance.
 */
interface AppContext {
  appId?: string;
  appOwnerId?: string;
  creatorId?: string;
}

/**
 * Reward amounts (in dollars/credits). WHY minted not carved: Signup/qualified bonuses
 * are customer acquisition cost; we don't deduct them from any purchase so we never
 * risk over-allocating revenue. Revenue share for referrers is handled by the 50/40/10
 * split in calculateRevenueSplits, not by a separate commission.
 */
const REWARDS = {
  SIGNUP_BONUS: 1.0, // Referrer gets $1 (100 credits) when someone signs up with their code
  REFERRED_BONUS: 0.5, // New user gets $0.50 (50 credits) for using a referral code
  QUALIFIED_BONUS: 0.5, // Referrer gets $0.50 (50 credits) when referred user links social account
  SHARE_X: 0.25,
  SHARE_FARCASTER: 0.25,
  SHARE_TELEGRAM: 0.25,
  SHARE_DISCORD: 0.25,
} as const;

/**
 * Referral revenue split (must sum to 1.0). Used by calculateRevenueSplits.
 * WHY single source of truth: So we never over- or under-allocate; changing one
 * number without fixing the others would break the invariant. Assertions below
 * enforce 50+40+10=100% and 8+2=10% at startup.
 * - ELIZA_CLOUD: platform share
 * - APP_OWNER: app owner share (or ELIZA_CLOUD if no app_owner_id)
 * - CREATOR: creator share; with multi-tier this becomes CREATOR_TIER + EDITOR_TIER
 */
export const REFERRAL_REVENUE_SPLITS = {
  ELIZA_CLOUD: 0.5,
  APP_OWNER: 0.4,
  CREATOR: 0.1,
  /** Multi-tier: creator gets 8%, editor (parent) gets 2% of purchase */
  CREATOR_TIER: 0.08,
  EDITOR_TIER: 0.02,
} as const;

const SPLITS_TOTAL =
  REFERRAL_REVENUE_SPLITS.ELIZA_CLOUD +
  REFERRAL_REVENUE_SPLITS.APP_OWNER +
  REFERRAL_REVENUE_SPLITS.CREATOR;
if (Math.abs(SPLITS_TOTAL - 1) > 1e-9) {
  throw new Error(
    `Referral revenue splits must sum to 1.0 (got ${SPLITS_TOTAL}). Fix REFERRAL_REVENUE_SPLITS.`,
  );
}
const MULTI_TIER_TOTAL = REFERRAL_REVENUE_SPLITS.CREATOR_TIER + REFERRAL_REVENUE_SPLITS.EDITOR_TIER;
if (Math.abs(MULTI_TIER_TOTAL - REFERRAL_REVENUE_SPLITS.CREATOR) > 1e-9) {
  throw new Error(
    `Multi-tier creator split must equal CREATOR (${REFERRAL_REVENUE_SPLITS.CREATOR}); got ${MULTI_TIER_TOTAL}.`,
  );
}

/**
 * Social platform identifier.
 */
type SocialPlatform = "x" | "farcaster" | "telegram" | "discord";

/**
 * Share type identifier.
 */
type ShareType = "app_share" | "character_share" | "invite_share";

/**
 * Generates a unique referral code for a user.
 *
 * @param userId - User ID.
 * @returns Referral code string.
 */
function generateReferralCode(userId: string): string {
  const prefix = userId.substring(0, 4).toUpperCase();
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}-${random}`;
}

/**
 * Service for managing referral programs and social sharing rewards.
 */
export class ReferralsService {
  /**
   * Ensures the user has exactly one `referral_codes` row (generated string).
   * Exposed to HTTP clients via GET `/api/v1/referrals`. WHY idempotent create here: Dashboard can
   * call repeatedly from header + Affiliates without a separate "create code" mutation.
   *
   * Concurrency: `user_id` is UNIQUE; two parallel first-time callers may both miss `findByUserId`
   * and one INSERT can hit 23505—handled by re-fetching by `user_id` and retrying code generation.
   */
  async getOrCreateCode(userId: string): Promise<ReferralCode> {
    const existing = await referralCodesRepository.findByUserId(userId);
    if (existing) return existing;

    let attempts = 0;

    while (attempts < 10) {
      const code = generateReferralCode(userId);
      const existingCode = await referralCodesRepository.findByCode(code);
      if (existingCode) {
        attempts++;
        continue;
      }

      try {
        return await referralCodesRepository.create({
          user_id: userId,
          code,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          const concurrentCode = await referralCodesRepository.findByUserId(userId);
          if (concurrentCode) {
            return concurrentCode;
          }
          attempts++;
          continue;
        }
        throw error;
      }
    }

    throw new Error("Failed to generate a unique referral code");
  }

  async getCodeByUser(userId: string): Promise<ReferralCode | null> {
    return referralCodesRepository.findByUserId(userId);
  }

  async findByCode(code: string): Promise<ReferralCode | null> {
    return referralCodesRepository.findByCode(code.trim().toUpperCase());
  }

  async applyReferralCode(
    referredUserId: string,
    organizationId: string,
    code: string,
    appContext?: AppContext,
  ): Promise<{ success: boolean; message: string; bonusAmount?: number }> {
    const normalizedCode = code.trim().toUpperCase();

    const existingSignup = await referralSignupsRepository.findByReferredUserId(referredUserId);
    if (existingSignup) {
      const existingCode = await referralCodesRepository.findByCode(normalizedCode);
      if (existingCode && existingSignup.referral_code_id === existingCode.id) {
        return { success: true, message: "Referral code already applied" };
      }
      return { success: false, message: "Already used a referral code" };
    }

    const referralCode = await referralCodesRepository.findByCode(normalizedCode);
    if (!referralCode) {
      return { success: false, message: "Invalid referral code" };
    }

    if (!referralCode.is_active) {
      return { success: false, message: "Referral code is no longer active" };
    }

    if (referralCode.user_id === referredUserId) {
      return { success: false, message: "Cannot use your own referral code" };
    }

    // Prevent self-referral abuse via app owner revenue share
    if (appContext?.appOwnerId === referredUserId) {
      return {
        success: false,
        message: "Cannot claim app owner revenue from your own purchase",
      };
    }

    // Get referrer's organization to credit them
    const referrer = await usersRepository.findById(referralCode.user_id);
    if (!referrer?.organization_id) {
      logger.warn("[Referrals] Referrer has no organization", {
        referrerId: referralCode.user_id,
      });
      return { success: false, message: "Referral code is invalid" };
    }

    // Create the signup record
    let signup: ReferralSignup;
    try {
      signup = await referralSignupsRepository.create({
        referral_code_id: referralCode.id,
        referrer_user_id: referralCode.user_id,
        referred_user_id: referredUserId,
        app_owner_id: appContext?.appOwnerId || null,
        creator_id: appContext?.creatorId || referralCode.user_id,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const concurrentSignup =
          await referralSignupsRepository.findByReferredUserId(referredUserId);
        if (concurrentSignup?.referral_code_id === referralCode.id) {
          return { success: true, message: "Referral code already applied" };
        }
        return { success: false, message: "Already used a referral code" };
      }
      throw error;
    }

    // Award bonus to referred user (app-specific or org balance)
    if (appContext?.appId) {
      // App-specific credits for app users
      await appCreditsService.addCredits(
        appContext.appId,
        referredUserId,
        REWARDS.REFERRED_BONUS,
        "Referral signup bonus",
      );
    } else {
      // Org balance for cloud users
      await creditsService.addCredits({
        organizationId,
        amount: REWARDS.REFERRED_BONUS,
        description: "Referral signup bonus",
        metadata: { referral_code: normalizedCode, type: "referral_bonus" },
      });
    }

    // Award signup bonus to referrer (always goes to org balance - referrer is cloud user)
    await creditsService.addCredits({
      organizationId: referrer.organization_id,
      amount: REWARDS.SIGNUP_BONUS,
      description: "Referral signup bonus - new user joined",
      metadata: {
        referred_user_id: referredUserId,
        type: "referral_signup_bonus",
      },
    });

    // PERFORMANCE: Mark signup bonus as credited and update stats in parallel
    await Promise.all([
      referralSignupsRepository.markBonusCredited(signup.id, REWARDS.SIGNUP_BONUS),
      referralCodesRepository.incrementReferrals(referralCode.id),
      referralCodesRepository.addSignupEarnings(referralCode.id, REWARDS.SIGNUP_BONUS),
    ]);

    logger.info("[Referrals] Referral code applied", {
      referredUserId,
      referrerId: referralCode.user_id,
      code: normalizedCode,
      referredBonus: REWARDS.REFERRED_BONUS,
      referrerBonus: REWARDS.SIGNUP_BONUS,
      appId: appContext?.appId,
    });

    return {
      success: true,
      message: `You received ${Math.round(REWARDS.REFERRED_BONUS * 100)} bonus credits!`,
      bonusAmount: REWARDS.REFERRED_BONUS,
    };
  }

  /**
   * Calculates the revenue splits for a purchase based on the 50/40/10 structure
   * and multi-tier "referrals of referrals" logic.
   * WHY assert total === purchaseAmount: Prevents logic bugs (e.g. missing branch)
   * from silently over- or under-paying; fail fast instead of wrong payouts.
   */
  async calculateRevenueSplits(
    userId: string,
    purchaseAmount: number,
  ): Promise<{
    elizaCloudAmount: number;
    splits: Array<{
      userId: string;
      role: "app_owner" | "creator" | "editor";
      amount: number;
    }>;
  }> {
    const signup = await referralSignupsRepository.findByReferredUserId(userId);

    // Default: 100% to ElizaCloud if no referrer
    if (!signup) {
      return { elizaCloudAmount: purchaseAmount, splits: [] };
    }

    const { ELIZA_CLOUD, APP_OWNER, CREATOR, CREATOR_TIER, EDITOR_TIER } = REFERRAL_REVENUE_SPLITS;

    let elizaCloudAmount = purchaseAmount * ELIZA_CLOUD;
    const appOwnerAmount = purchaseAmount * APP_OWNER;
    const baseCreatorAmount = purchaseAmount * CREATOR;

    const splits: Array<{
      userId: string;
      role: "app_owner" | "creator" | "editor";
      amount: number;
    }> = [];

    if (signup.app_owner_id) {
      splits.push({
        userId: signup.app_owner_id,
        role: "app_owner",
        amount: appOwnerAmount,
      });
    } else {
      elizaCloudAmount += appOwnerAmount;
    }

    const creatorId = signup.creator_id || signup.referrer_user_id;

    const referralCode = await referralCodesRepository.findById(signup.referral_code_id);
    if (referralCode && referralCode.parent_referral_id) {
      const parentCode = await referralCodesRepository.findById(referralCode.parent_referral_id);
      if (parentCode) {
        splits.push({
          userId: creatorId,
          role: "creator",
          amount: purchaseAmount * CREATOR_TIER,
        });
        splits.push({
          userId: parentCode.user_id,
          role: "editor",
          amount: purchaseAmount * EDITOR_TIER,
        });
      } else {
        splits.push({
          userId: creatorId,
          role: "creator",
          amount: baseCreatorAmount,
        });
      }
    } else {
      splits.push({
        userId: creatorId,
        role: "creator",
        amount: baseCreatorAmount,
      });
    }

    const splitsSum = splits.reduce((s, x) => s + x.amount, 0);
    const totalAllocated = elizaCloudAmount + splitsSum;
    if (Math.abs(totalAllocated - purchaseAmount) > 1e-6) {
      throw new Error(
        `Referral revenue split total must equal purchaseAmount: ${totalAllocated} !== ${purchaseAmount}`,
      );
    }

    return { elizaCloudAmount, splits };
  }

  async getReferralStats(userId: string): Promise<{
    code: string | null;
    totalReferrals: number;
    totalEarnings: number;
    signupEarnings: number;
    qualifiedEarnings: number;
    commissionEarnings: number;
    recentReferrals: ReferralSignup[];
  }> {
    // PERFORMANCE: Fetch code and recent referrals in parallel
    const [referralCode, recentReferrals] = await Promise.all([
      referralCodesRepository.findByUserId(userId),
      referralSignupsRepository.listByReferrerId(userId, 10),
    ]);

    if (!referralCode) {
      return {
        code: null,
        totalReferrals: 0,
        totalEarnings: 0,
        signupEarnings: 0,
        qualifiedEarnings: 0,
        commissionEarnings: 0,
        recentReferrals: [],
      };
    }

    return {
      code: referralCode.code,
      totalReferrals: referralCode.total_referrals,
      totalEarnings:
        Number(referralCode.total_signup_earnings) +
        Number(referralCode.total_qualified_earnings) +
        Number(referralCode.total_commission_earnings),
      signupEarnings: Number(referralCode.total_signup_earnings),
      qualifiedEarnings: Number(referralCode.total_qualified_earnings),
      commissionEarnings: Number(referralCode.total_commission_earnings),
      recentReferrals,
    };
  }

  /**
   * Check and qualify a referral when the referred user links a social account.
   * Awards the referrer a qualified bonus.
   *
   * Call this when a user links Farcaster, Twitter, or a wallet.
   * Note: Qualified bonus always goes to referrer's org balance (they're a cloud user).
   */
  async checkAndQualifyReferral(
    referredUserId: string,
  ): Promise<{ qualified: boolean; bonusAwarded?: number }> {
    // Find unqualified referral for this user
    const signup = await referralSignupsRepository.findUnqualifiedByReferredUserId(referredUserId);

    if (!signup) {
      return { qualified: false };
    }

    // Get referrer's organization to credit them
    const referrer = await usersRepository.findById(signup.referrer_user_id);
    if (!referrer?.organization_id) {
      logger.warn("[Referrals] Referrer has no organization for qualified bonus", {
        referrerId: signup.referrer_user_id,
      });
      return { qualified: false };
    }

    const marked = await referralSignupsRepository.markQualified(
      signup.id,
      REWARDS.QUALIFIED_BONUS,
    );
    if (!marked) {
      return { qualified: false };
    }

    // Award qualified bonus to referrer (always org balance - referrer is cloud user)
    await creditsService.addCredits({
      organizationId: referrer.organization_id,
      amount: REWARDS.QUALIFIED_BONUS,
      description: "Referral qualified bonus - referred user linked social account",
      metadata: {
        referred_user_id: referredUserId,
        type: "referral_qualified_bonus",
      },
    });

    await referralCodesRepository.addQualifiedEarnings(
      signup.referral_code_id,
      REWARDS.QUALIFIED_BONUS,
    );

    logger.info("[Referrals] Referral qualified", {
      referredUserId,
      referrerId: signup.referrer_user_id,
      bonus: REWARDS.QUALIFIED_BONUS,
    });

    return { qualified: true, bonusAwarded: REWARDS.QUALIFIED_BONUS };
  }
}

export class SocialRewardsService {
  /**
   * Record a share intent and award credits immediately.
   *
   * This follows Babylon's pattern:
   * 1. User clicks share button
   * 2. We record the intent and award credits server-side
   * 3. Share window opens (client-side)
   * 4. Daily limit prevents abuse (one share per platform per day)
   *
   * Uses atomic check-and-insert to prevent race conditions from concurrent requests.
   */
  async claimShareReward(
    userId: string,
    organizationId: string,
    platform: SocialPlatform,
    shareType: ShareType,
    shareUrl?: string,
    appContext?: AppContext,
  ): Promise<{
    success: boolean;
    message: string;
    amount?: number;
    alreadyAwarded?: boolean;
  }> {
    const rewardAmount = this.getRewardAmount(platform);

    // Atomically check if claimed today and create record if not
    // This prevents race conditions where multiple concurrent requests could both pass the check
    const shareRecord = await socialShareRewardsRepository.createIfNotClaimedToday(
      userId,
      platform,
      {
        share_type: shareType,
        share_url: shareUrl,
        credits_awarded: String(rewardAmount),
      },
    );

    if (!shareRecord) {
      return {
        success: false,
        message: `Already claimed ${platform} share reward today. Try again tomorrow!`,
        alreadyAwarded: true,
      };
    }

    // Award credits (app-specific or org balance)
    if (appContext?.appId) {
      // App-specific credits for app users
      await appCreditsService.addCredits(
        appContext.appId,
        userId,
        rewardAmount,
        `Social share reward (${platform})`,
      );
    } else {
      // Org balance for cloud users
      await creditsService.addCredits({
        organizationId,
        amount: rewardAmount,
        description: `Social share reward (${platform})`,
        metadata: {
          platform,
          share_type: shareType,
          share_url: shareUrl,
          share_record_id: shareRecord.id,
        },
      });
    }

    // Mark as verified (since we're awarding immediately)
    await socialShareRewardsRepository.markVerified(shareRecord.id);

    logger.info("[Social Rewards] Share reward claimed", {
      userId,
      platform,
      shareType,
      amount: rewardAmount,
      shareRecordId: shareRecord.id,
      appId: appContext?.appId,
    });

    return {
      success: true,
      message: `You earned ${Math.round(rewardAmount * 100)} credits for sharing on ${platform}!`,
      amount: rewardAmount,
      alreadyAwarded: false,
    };
  }

  async getShareStatus(
    userId: string,
  ): Promise<Record<SocialPlatform, { claimed: boolean; amount: number }>> {
    const platforms: SocialPlatform[] = ["x", "farcaster", "telegram", "discord"];

    // PERFORMANCE: Check all platforms in parallel instead of sequential loop
    const claimedStatuses = await Promise.all(
      platforms.map((platform) => socialShareRewardsRepository.hasClaimedToday(userId, platform)),
    );

    return {
      x: { claimed: claimedStatuses[0], amount: REWARDS.SHARE_X },
      farcaster: {
        claimed: claimedStatuses[1],
        amount: REWARDS.SHARE_FARCASTER,
      },
      telegram: { claimed: claimedStatuses[2], amount: REWARDS.SHARE_TELEGRAM },
      discord: { claimed: claimedStatuses[3], amount: REWARDS.SHARE_DISCORD },
    };
  }

  async getTotalEarnings(userId: string): Promise<number> {
    return socialShareRewardsRepository.getTotalEarnings(userId);
  }

  async getRewardHistory(userId: string, limit = 50): Promise<SocialShareReward[]> {
    return socialShareRewardsRepository.listByUserId(userId, limit);
  }

  private getRewardAmount(platform: SocialPlatform): number {
    switch (platform) {
      case "x":
        return REWARDS.SHARE_X;
      case "farcaster":
        return REWARDS.SHARE_FARCASTER;
      case "telegram":
        return REWARDS.SHARE_TELEGRAM;
      case "discord":
        return REWARDS.SHARE_DISCORD;
      default:
        return 0;
    }
  }
}

export const referralsService = new ReferralsService();
export const socialRewardsService = new SocialRewardsService();

export { REWARDS };
