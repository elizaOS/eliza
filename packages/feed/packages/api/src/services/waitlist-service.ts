/**
 * Waitlist Service
 *
 * @description Manages waitlist signups, position tracking, and invite code
 * generation. Handles referral tracking, position calculations based on points,
 * and leaderboard rankings for waitlist participants.
 */

import {
  and,
  asc,
  count,
  db,
  desc,
  eq,
  gt,
  lt,
  ne,
  or,
  pointsTransactions,
  referrals,
  users,
} from "@feed/db";
import { generateSnowflakeId, logger, POINTS } from "@feed/shared";
import { nanoid } from "nanoid";
import { NotFoundError } from "../errors";
import { getOrCreateReferralCode } from "./referral-service";
import { ReputationService } from "./reputation-service";

export interface WaitlistMarkResult {
  success: boolean;
  waitlistPosition: number;
  inviteCode: string;
  points: number;
  referrerRewarded?: boolean;
  error?: string;
}

export interface WaitlistPosition {
  waitlistPosition: number; // Historical signup order (for records)
  leaderboardRank: number; // Actual position in line (dynamic, based on points)
  totalAhead: number; // How many people are ahead (by points)
  totalCount: number; // Total people on waitlist
  percentile: number; // Top X% of waitlist
  inviteCode: string;
  points: number;
  invitePoints: number;
  earnedPoints: number;
  bonusPoints: number;
  referralCount: number;
}

export class WaitlistService {
  /**
   * Generate a unique invite code
   */
  static generateInviteCode(): string {
    return nanoid(8).toUpperCase();
  }

  /**
   * Mark an existing user as waitlisted
   *
   * @description Marks a user as waitlisted after they complete onboarding.
   * Users must be created through the normal onboarding flow before calling
   * this method. Handles referral code processing and initial point awards.
   *
   * @param {string} userId - User ID to mark as waitlisted
   * @param {string} [referralCode] - Optional referral code used during signup
   * @returns {Promise<WaitlistMarkResult>} Waitlist marking result with position and invite code
   */
  static async markAsWaitlisted(
    userId: string,
    referralCode?: string,
  ): Promise<WaitlistMarkResult> {
    // Get user - they should already exist from onboarding
    const userResult = await db
      .select({
        id: users.id,
        waitlistPosition: users.waitlistPosition,
        referralCode: users.referralCode,
        referredBy: users.referredBy,
        reputationPoints: users.reputationPoints,
        invitePoints: users.invitePoints,
        earnedPoints: users.earnedPoints,
        bonusPoints: users.bonusPoints,
        isWaitlistActive: users.isWaitlistActive,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const user = userResult[0];

    if (!user) {
      throw new NotFoundError("User", undefined, {
        userId,
        message: "User must complete onboarding before joining waitlist",
      });
    }

    // If user already marked as waitlisted, still check for referral code validation
    // but don't change their position or status
    if (user.waitlistPosition && user.isWaitlistActive) {
      // Still validate referral code if provided (for self-referral/double-referral checks)
      let referrerRewarded = false;

      if (referralCode) {
        const referrerResult = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.referralCode, referralCode))
          .limit(1);

        const referrer = referrerResult[0];

        if (referrer) {
          // PREVENT SELF-REFERRAL: Can't refer yourself!
          if (referrer.id === userId) {
            logger.warn(
              `User ${userId} attempted self-referral`,
              {
                userId,
                referralCode,
              },
              "WaitlistService",
            );
            referrerRewarded = false;
          }
          // PREVENT DOUBLE-REFERRAL: Check if user was already referred
          else if (user.referredBy) {
            logger.warn(
              `User ${userId} already referred by ${user.referredBy}, ignoring new referral`,
              {
                userId,
                existingReferrer: user.referredBy,
                attemptedReferrer: referrer.id,
              },
              "WaitlistService",
            );
            referrerRewarded = false;
          }
          // Valid referral - but user already waitlisted, so don't reward again
          else {
            referrerRewarded = false;
            logger.info(
              `User ${userId} already waitlisted, referral code ${referralCode} ignored`,
              {
                userId,
                referralCode,
              },
              "WaitlistService",
            );
          }
        }
      }

      return {
        success: true,
        waitlistPosition: user.waitlistPosition,
        inviteCode: user.referralCode || "",
        points: user.reputationPoints,
        referrerRewarded,
      };
    }

    // Get the highest waitlist position
    const lastPositionResult = await db
      .select({ waitlistPosition: users.waitlistPosition })
      .from(users)
      .where(ne(users.waitlistPosition, 0))
      .orderBy(desc(users.waitlistPosition))
      .limit(1);

    const lastPosition = lastPositionResult[0];
    const newPosition = (lastPosition?.waitlistPosition || 0) + 1;

    // Generate invite code if user doesn't have one
    const inviteCode =
      user.referralCode || WaitlistService.generateInviteCode();

    // Handle referral rewards with validation
    let referrerRewarded = false;

    if (referralCode) {
      const referrerResult = await db
        .select({
          id: users.id,
          reputationPoints: users.reputationPoints,
          invitePoints: users.invitePoints,
          referralCount: users.referralCount,
        })
        .from(users)
        .where(eq(users.referralCode, referralCode))
        .limit(1);

      const referrer = referrerResult[0];

      if (referrer) {
        // PREVENT SELF-REFERRAL: Can't refer yourself!
        if (referrer.id === userId) {
          logger.warn(
            `User ${userId} attempted self-referral`,
            {
              userId,
              referralCode,
            },
            "WaitlistService",
          );
          referrerRewarded = false;
        }
        // PREVENT DOUBLE-REFERRAL: Check if user was already referred
        else if (user.referredBy) {
          logger.warn(
            `User ${userId} already referred by ${user.referredBy}, ignoring new referral`,
            {
              userId,
              existingReferrer: user.referredBy,
              attemptedReferrer: referrer.id,
            },
            "WaitlistService",
          );
          referrerRewarded = false;
        }
        // Valid referral - use referral system
        else {
          // Use ReputationService.awardReferralSignup for referral processing
          // This handles weekly limits, IP checks, and creates proper Referral records
          const referralResult = await ReputationService.awardReferralSignup(
            referrer.id,
            userId,
          );

          if (referralResult.success) {
            // Create or update Referral record if it doesn't exist
            // Check if referral exists
            const existingReferral = await db
              .select({ id: referrals.id })
              .from(referrals)
              .where(
                and(
                  eq(referrals.referralCode, referralCode),
                  eq(referrals.referredUserId, userId),
                ),
              )
              .limit(1);

            if (existingReferral.length > 0) {
              await db
                .update(referrals)
                .set({
                  status: "completed",
                  completedAt: new Date(),
                })
                .where(
                  and(
                    eq(referrals.referralCode, referralCode),
                    eq(referrals.referredUserId, userId),
                  ),
                );
            } else {
              await db.insert(referrals).values({
                id: await generateSnowflakeId(),
                referrerId: referrer.id,
                referralCode,
                referredUserId: userId,
                status: "completed",
                completedAt: new Date(),
              });
            }

            // Update referredBy field on user
            await db
              .update(users)
              .set({ referredBy: referrer.id })
              .where(eq(users.id, userId));

            referrerRewarded = true;

            logger.info(
              `Rewarded referrer ${referrer.id} with ${referralResult.reputationAwarded} reputation via referral system`,
              {
                referrerId: referrer.id,
                reputationAwarded: referralResult.reputationAwarded,
                newReputationTotal: referralResult.newReputationTotal,
              },
              "WaitlistService",
            );
          } else {
            // Referral failed (weekly limit, IP check, etc.)
            logger.warn(
              `Failed to award referral points: ${referralResult.error}`,
              {
                referrerId: referrer.id,
                referredUserId: userId,
                error: referralResult.error,
              },
              "WaitlistService",
            );
            referrerRewarded = false;
          }
        }
      } else {
        logger.warn(
          `Invalid referral code: ${referralCode}`,
          {
            userId,
            referralCode,
          },
          "WaitlistService",
        );
      }
    }

    // Ensure user has a referral code
    if (!user.referralCode) {
      await getOrCreateReferralCode(userId);
    }

    // Update user as waitlisted
    // IMPORTANT: Don't change reputationPoints here - they should already have correct amount from onboarding
    // referredBy is already set above if referral was processed
    await db
      .update(users)
      .set({
        waitlistPosition: newPosition,
        waitlistJoinedAt: new Date(),
        isWaitlistActive: true,
        referralCode: inviteCode,
      })
      .where(eq(users.id, userId));

    logger.info(
      "User marked as waitlisted",
      {
        userId,
        position: newPosition,
        referrerRewarded,
      },
      "WaitlistService",
    );

    return {
      success: true,
      waitlistPosition: newPosition,
      inviteCode,
      points: user.reputationPoints,
      referrerRewarded,
    };
  }

  /**
   * Graduate a user from waitlist to full access
   */
  static async graduateFromWaitlist(userId: string): Promise<boolean> {
    await db
      .update(users)
      .set({
        isWaitlistActive: false,
        waitlistGraduatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    logger.info("User graduated from waitlist", { userId }, "WaitlistService");
    return true;
  }

  /**
   * Get user's waitlist position and stats
   * CRITICAL: Position is based on INVITE POINTS (leaderboard rank), not signup order!
   * This creates the viral loop incentive.
   */
  static async getWaitlistPosition(
    userId: string,
  ): Promise<WaitlistPosition | null> {
    const userResult = await db
      .select({
        waitlistPosition: users.waitlistPosition,
        waitlistJoinedAt: users.waitlistJoinedAt,
        isWaitlistActive: users.isWaitlistActive,
        referralCode: users.referralCode,
        reputationPoints: users.reputationPoints,
        invitePoints: users.invitePoints,
        earnedPoints: users.earnedPoints,
        bonusPoints: users.bonusPoints,
        referralCount: users.referralCount,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const user = userResult[0];

    if (!user?.isWaitlistActive) {
      return null;
    }

    // Count users ahead in line based on INVITE POINTS (viral loop!)
    // Users with more invites are closer to the front
    const userJoinedAt = user.waitlistJoinedAt || new Date();

    const [usersAheadResult] = await db
      .select({ count: count() })
      .from(users)
      .where(
        and(
          eq(users.isWaitlistActive, true),
          or(
            // Primary sort: More invite points = better position
            gt(users.invitePoints, user.invitePoints),
            // Tie-breaker: If same invite points, earlier signup wins
            and(
              eq(users.invitePoints, user.invitePoints),
              lt(users.waitlistJoinedAt, userJoinedAt),
            ),
          ),
        ),
      );

    const usersAhead = usersAheadResult?.count ?? 0;

    // Calculate leaderboard rank (actual position in line)
    const leaderboardRank = usersAhead + 1;

    // Get total waitlist count
    const totalCount = await WaitlistService.getTotalWaitlistCount();

    // Calculate percentile (Top X% - what percentile you're in from the top)
    const percentile =
      totalCount > 0 ? Math.round((leaderboardRank / totalCount) * 100) : 100;

    return {
      waitlistPosition: user.waitlistPosition || 0, // Historical record
      leaderboardRank, // What users see!
      totalAhead: usersAhead,
      totalCount,
      percentile,
      inviteCode: user.referralCode || "",
      points: user.reputationPoints,
      invitePoints: user.invitePoints,
      earnedPoints: user.earnedPoints,
      bonusPoints: user.bonusPoints,
      referralCount: user.referralCount,
    };
  }

  /**
   * Award bonus points for wallet connection
   */
  static async awardWalletBonus(
    userId: string,
    walletAddress: string,
  ): Promise<boolean> {
    const userResult = await db
      .select({
        pointsAwardedForWallet: users.pointsAwardedForWallet,
        reputationPoints: users.reputationPoints,
        bonusPoints: users.bonusPoints,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const user = userResult[0];

    if (!user) {
      return false;
    }

    // Don't award if already awarded
    if (user.pointsAwardedForWallet) {
      return false;
    }

    const bonusAmount = 300;
    const newBonusPoints = user.bonusPoints + bonusAmount;
    const newReputationPoints = user.reputationPoints + bonusAmount;

    await db
      .update(users)
      .set({
        walletAddress,
        pointsAwardedForWallet: true,
        bonusPoints: newBonusPoints,
        reputationPoints: newReputationPoints,
      })
      .where(eq(users.id, userId));

    // Create points transaction
    await db.insert(pointsTransactions).values({
      id: await generateSnowflakeId(),
      userId,
      amount: bonusAmount,
      pointsBefore: user.reputationPoints,
      pointsAfter: newReputationPoints,
      reason: "wallet_connect",
      metadata: JSON.stringify({ walletAddress }),
    });

    logger.info(
      `Awarded wallet bonus to user ${userId}`,
      {
        userId,
        bonusAmount,
      },
      "WaitlistService",
    );

    return true;
  }

  /**
   * Award bonus points for providing an email address (one-time bonus).
   * Saves the email and sets pointsAwardedForEmail to prevent double-awarding.
   */
  static async awardEmailBonus(
    userId: string,
    email: string,
  ): Promise<boolean> {
    const userResult = await db
      .select({
        isWaitlistActive: users.isWaitlistActive,
        pointsAwardedForEmail: users.pointsAwardedForEmail,
        reputationPoints: users.reputationPoints,
        bonusPoints: users.bonusPoints,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const user = userResult[0];

    if (!user?.isWaitlistActive) {
      return false;
    }

    if (user.pointsAwardedForEmail) {
      return false;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const bonusAmount = POINTS.EMAIL_SUBMIT;
    const newBonusPoints = user.bonusPoints + bonusAmount;
    const newReputationPoints = user.reputationPoints + bonusAmount;

    await db
      .update(users)
      .set({
        email: normalizedEmail,
        pointsAwardedForEmail: true,
        bonusPoints: newBonusPoints,
        reputationPoints: newReputationPoints,
      })
      .where(eq(users.id, userId));

    await db.insert(pointsTransactions).values({
      id: await generateSnowflakeId(),
      userId,
      amount: bonusAmount,
      pointsBefore: user.reputationPoints,
      pointsAfter: newReputationPoints,
      reason: "email_submit",
    });

    logger.info(
      `Awarded email bonus to user ${userId}`,
      { userId, bonusAmount },
      "WaitlistService",
    );

    return true;
  }

  /**
   * Get total waitlist count
   */
  static async getTotalWaitlistCount(): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(users)
      .where(
        and(ne(users.waitlistPosition, 0), eq(users.isWaitlistActive, true)),
      );

    return result?.count ?? 0;
  }

  /**
   * Get top waitlist users (leaderboard)
   * Sorted by invite points (most invites = best position)
   * Supports pagination with offset
   */
  static async getTopWaitlistUsers(
    limit = 10,
    offset = 0,
    pointsType: "total" | "invite" = "invite",
  ) {
    // Ensure limit is reasonable
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const safeOffset = Math.max(0, offset);

    // Build orderBy based on pointsType
    const orderByColumns =
      pointsType === "total"
        ? [
            desc(users.reputationPoints),
            desc(users.invitePoints),
            asc(users.waitlistJoinedAt),
          ]
        : [
            desc(users.invitePoints),
            desc(users.reputationPoints),
            asc(users.waitlistJoinedAt),
          ];

    const usersResult = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        // profileImageUrl removed - fetch on-demand to reduce bandwidth
        invitePoints: users.invitePoints,
        reputationPoints: users.reputationPoints,
        referralCount: users.referralCount,
        waitlistJoinedAt: users.waitlistJoinedAt,
      })
      .from(users)
      .where(
        and(
          eq(users.isWaitlistActive, true),
          // Only include users with usernames (required for referral codes)
          ne(users.username, ""),
        ),
      )
      .orderBy(...orderByColumns)
      .offset(safeOffset)
      .limit(safeLimit);

    return usersResult.map((user, index) => ({
      id: user.id, // For frontend compatibility (TopUser interface expects 'id')
      userId: user.id, // Keep for backward compatibility
      username: user.username,
      displayName: user.displayName,
      // profileImageUrl removed - fetch on-demand when profile is clicked to reduce bandwidth
      points:
        pointsType === "total" ? user.reputationPoints : user.invitePoints, // Keep for backward compatibility
      invitePoints: user.invitePoints, // For frontend TopUser interface
      reputationPoints: user.reputationPoints, // For frontend TopUser interface
      referralCount: user.referralCount,
      rank: safeOffset + index + 1, // Adjust rank based on offset
    }));
  }
}
