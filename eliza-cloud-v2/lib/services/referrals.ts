import {
  referralCodesRepository,
  referralSignupsRepository,
  socialShareRewardsRepository,
  type ReferralCode,
  type ReferralSignup,
  type SocialShareReward,
} from "@/db/repositories/referrals";
import { usersRepository } from "@/db/repositories/users";
import { creditsService } from "./credits";
import { appCreditsService } from "./app-credits";
import { logger } from "@/lib/utils/logger";
import * as crypto from "crypto";

/**
 * Service for managing referral codes, signups, and social share rewards.
 */

/**
 * Context for app-specific operations.
 * When appId is provided, credits go to app balance instead of org balance.
 */
interface AppContext {
  appId?: string;
}

// Reward amounts (in dollars/credits)
const REWARDS = {
  SIGNUP_BONUS: 1.0, // Referrer gets $1 (100 credits) when someone signs up with their code
  REFERRED_BONUS: 0.5, // New user gets $0.50 (50 credits) for using a referral code
  QUALIFIED_BONUS: 0.5, // Referrer gets $0.50 (50 credits) when referred user links social account
  COMMISSION_RATE: 0.05, // 5% commission on referral purchases
  SHARE_X: 0.25,
  SHARE_FARCASTER: 0.25,
  SHARE_TELEGRAM: 0.25,
  SHARE_DISCORD: 0.25,
} as const;

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
  async getOrCreateCode(userId: string): Promise<ReferralCode> {
    const existing = await referralCodesRepository.findByUserId(userId);
    if (existing) return existing;

    let code = generateReferralCode(userId);
    let attempts = 0;

    while (attempts < 10) {
      const existingCode = await referralCodesRepository.findByCode(code);
      if (!existingCode) break;
      code = generateReferralCode(userId);
      attempts++;
    }

    return await referralCodesRepository.create({
      user_id: userId,
      code,
    });
  }

  async getCodeByUser(userId: string): Promise<ReferralCode | null> {
    return referralCodesRepository.findByUserId(userId);
  }

  async findByCode(code: string): Promise<ReferralCode | null> {
    return referralCodesRepository.findByCode(code);
  }

  async applyReferralCode(
    referredUserId: string,
    organizationId: string,
    code: string,
    appContext?: AppContext,
  ): Promise<{ success: boolean; message: string; bonusAmount?: number }> {
    const existingSignup =
      await referralSignupsRepository.findByReferredUserId(referredUserId);
    if (existingSignup) {
      return { success: false, message: "Already used a referral code" };
    }

    const referralCode = await referralCodesRepository.findByCode(
      code.toUpperCase(),
    );
    if (!referralCode) {
      return { success: false, message: "Invalid referral code" };
    }

    if (!referralCode.is_active) {
      return { success: false, message: "Referral code is no longer active" };
    }

    if (referralCode.user_id === referredUserId) {
      return { success: false, message: "Cannot use your own referral code" };
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
    const signup = await referralSignupsRepository.create({
      referral_code_id: referralCode.id,
      referrer_user_id: referralCode.user_id,
      referred_user_id: referredUserId,
    });

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
        metadata: { referral_code: code, type: "referral_bonus" },
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
      referralSignupsRepository.markBonusCredited(
        signup.id,
        REWARDS.SIGNUP_BONUS,
      ),
      referralCodesRepository.incrementReferrals(referralCode.id),
      referralCodesRepository.addSignupEarnings(
        referralCode.id,
        REWARDS.SIGNUP_BONUS,
      ),
    ]);

    logger.info("[Referrals] Referral code applied", {
      referredUserId,
      referrerId: referralCode.user_id,
      code,
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

  async processReferralCommission(
    purchaserUserId: string,
    purchaseAmount: number,
    referrerOrganizationId: string,
  ): Promise<number> {
    const signup =
      await referralSignupsRepository.findByReferredUserId(purchaserUserId);
    if (!signup) return 0;

    const commission = purchaseAmount * REWARDS.COMMISSION_RATE;

    await creditsService.addCredits({
      organizationId: referrerOrganizationId,
      amount: commission,
      description: `Referral commission (${(REWARDS.COMMISSION_RATE * 100).toFixed(0)}%)`,
      metadata: {
        referred_user_id: purchaserUserId,
        purchase_amount: purchaseAmount,
        type: "referral_commission",
      },
    });

    // PERFORMANCE: Update commission stats in parallel
    await Promise.all([
      referralSignupsRepository.addCommission(signup.id, commission),
      referralCodesRepository.addCommissionEarnings(
        signup.referral_code_id,
        commission,
      ),
    ]);

    logger.info("[Referrals] Commission credited", {
      purchaserUserId,
      referrerId: signup.referrer_user_id,
      purchaseAmount,
      commission,
    });

    return commission;
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
    const signup =
      await referralSignupsRepository.findUnqualifiedByReferredUserId(
        referredUserId,
      );

    if (!signup) {
      return { qualified: false };
    }

    // Get referrer's organization to credit them
    const referrer = await usersRepository.findById(signup.referrer_user_id);
    if (!referrer?.organization_id) {
      logger.warn(
        "[Referrals] Referrer has no organization for qualified bonus",
        {
          referrerId: signup.referrer_user_id,
        },
      );
      return { qualified: false };
    }

    // Award qualified bonus to referrer (always org balance - referrer is cloud user)
    await creditsService.addCredits({
      organizationId: referrer.organization_id,
      amount: REWARDS.QUALIFIED_BONUS,
      description:
        "Referral qualified bonus - referred user linked social account",
      metadata: {
        referred_user_id: referredUserId,
        type: "referral_qualified_bonus",
      },
    });

    // PERFORMANCE: Mark signup as qualified and update earnings in parallel
    await Promise.all([
      referralSignupsRepository.markQualified(
        signup.id,
        REWARDS.QUALIFIED_BONUS,
      ),
      referralCodesRepository.addQualifiedEarnings(
        signup.referral_code_id,
        REWARDS.QUALIFIED_BONUS,
      ),
    ]);

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
    const shareRecord =
      await socialShareRewardsRepository.createIfNotClaimedToday(
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
    const platforms: SocialPlatform[] = [
      "x",
      "farcaster",
      "telegram",
      "discord",
    ];

    // PERFORMANCE: Check all platforms in parallel instead of sequential loop
    const claimedStatuses = await Promise.all(
      platforms.map((platform) =>
        socialShareRewardsRepository.hasClaimedToday(userId, platform),
      ),
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

  async getRewardHistory(
    userId: string,
    limit = 50,
  ): Promise<SocialShareReward[]> {
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
