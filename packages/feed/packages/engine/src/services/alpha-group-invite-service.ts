/**
 * Alpha Group Invite Service
 *
 * Invites users to NPC group chats based on engagement scores.
 * Uses tier-specific thresholds and per-NPC customization.
 *
 * Features:
 * - Tier-based invite probabilities (Tier 3: 10%, Tier 2: 2%, Tier 1: 0.5%)
 * - Trading activity included in engagement scoring
 * - Fast-track for high-value traders
 * - Invite decay for users who repeatedly decline
 * - Per-NPC threshold customization
 *
 * Runs on game ticks, processing a batch of NPCs each tick.
 */

import {
  and,
  count,
  db,
  desc,
  eq,
  groupInvites,
  groupMembers,
  groups,
  gte,
  or,
  userInteractions,
} from "@feed/db";
import { GROUP_CONFIG, logger, type TierLevel } from "@feed/shared";
import {
  ALPHA_GROUP_CONFIG,
  calculateNextEligibleDate,
  shouldResetDeclineCount,
} from "../config/alpha-group-config";
import { NPCInteractionTracker } from "./npc-interaction-tracker";
import { StaticDataRegistry } from "./static-data-registry";
import {
  getEffectiveTierConfig,
  getNpcFocusWeights,
  getTierForEngagementScoreWithNpc,
} from "./tier-config";
import { TieredGroupService } from "./tiered-group-service";

/**
 * Result of an alpha group invite.
 */
export interface AlphaInviteResult {
  npcId: string;
  npcName: string;
  userId: string;
  /** Tier the user was invited to */
  invitedToTier: TierLevel;
  /** Name of the chat/group */
  invitedToChat: string;
  /** User's engagement score (0-100) */
  engagementScore: number;
  /** Social component of engagement score */
  socialScore: number;
  /** Trading component of engagement score */
  tradingScore: number;
  /** Invite probability that was used */
  probability: number;
  /** Whether user was fast-tracked */
  fastTracked: boolean;
}

/**
 * Invite decay status for a user.
 */
interface InviteDecayStatus {
  canBeInvited: boolean;
  declineCount: number;
  nextEligibleAt: Date | null;
  reason?: string;
}

export class AlphaGroupInviteService {
  /**
   * Process alpha group invites for one tick.
   * Checks all NPCs and their top engaged users.
   */
  static async processTickInvites(): Promise<AlphaInviteResult[]> {
    const startTime = Date.now();
    const invites: AlphaInviteResult[] = [];

    // Get all NPCs (actors) from static registry
    const allActors = StaticDataRegistry.getAllActors();
    const npcs = allActors.map((a) => ({
      id: a.id,
      name: a.name,
      domain: a.domain,
      tierOverrides: a.tierOverrides,
    }));

    logger.info(
      `Processing alpha invites for ${npcs.length} NPCs`,
      {
        maxInvitesPerTick: ALPHA_GROUP_CONFIG.maxInvitesPerTick,
        topUsersToConsider: ALPHA_GROUP_CONFIG.topUsersToConsider,
      },
      "AlphaGroupInviteService",
    );

    // Process each NPC
    for (const npc of npcs) {
      if (invites.length >= ALPHA_GROUP_CONFIG.maxInvitesPerTick) {
        logger.debug(
          "Reached max invites per tick",
          { count: invites.length },
          "AlphaGroupInviteService",
        );
        break;
      }

      const npcInvites = await AlphaGroupInviteService.processNPCInvites(npc);
      invites.push(...npcInvites);
    }

    const duration = Date.now() - startTime;
    logger.info(
      `Alpha invite tick complete: ${invites.length} invites sent`,
      {
        duration,
        inviteCount: invites.length,
        npcsProcessed: npcs.length,
      },
      "AlphaGroupInviteService",
    );

    return invites;
  }

  /**
   * Process invites for a single NPC.
   */
  private static async processNPCInvites(npc: {
    id: string;
    name: string;
    domain?: string[];
  }): Promise<AlphaInviteResult[]> {
    const invites: AlphaInviteResult[] = [];

    // Get focus weights for this NPC (used in engagement calculation)
    const focusWeights = getNpcFocusWeights(npc.id);

    // Get top engaged users with this NPC
    const topUsers = await NPCInteractionTracker.getTopEngagedUsers(
      npc.id,
      ALPHA_GROUP_CONFIG.topUsersToConsider,
      undefined, // Use default 30-day window
      focusWeights,
    );

    for (const userScore of topUsers) {
      // Determine eligible tier using NPC-specific thresholds
      const eligibleTier = AlphaGroupInviteService.getEligibleTier(
        userScore.engagementScore,
        npc.id,
        userScore.qualifiesForFastTrack,
      );

      if (!eligibleTier) {
        // Below all tier thresholds
        continue;
      }

      // Check invite decay
      if (ALPHA_GROUP_CONFIG.inviteDecayEnabled) {
        const decayStatus = await AlphaGroupInviteService.checkInviteDecay(
          userScore.userId,
          npc.id,
        );
        if (!decayStatus.canBeInvited) {
          logger.debug(
            "User blocked by invite decay",
            {
              userId: userScore.userId,
              npcId: npc.id,
              declineCount: decayStatus.declineCount,
              reason: decayStatus.reason,
            },
            "AlphaGroupInviteService",
          );
          continue;
        }
      }

      // Check if already in a group with this NPC
      const hasExistingMembership =
        await AlphaGroupInviteService.checkExistingMembership(
          userScore.userId,
          npc.id,
        );
      if (hasExistingMembership) {
        continue;
      }

      // Check if user is at their NPC group limit
      const atGroupLimit = await AlphaGroupInviteService.checkGroupLimit(
        userScore.userId,
      );
      if (atGroupLimit) {
        continue;
      }

      // Check invite cooldown
      const inCooldown = await AlphaGroupInviteService.checkCooldown(
        userScore.userId,
      );
      if (inCooldown) {
        continue;
      }

      // Check weekly invite rate limit (prevents invite spam)
      const atWeeklyLimit =
        await AlphaGroupInviteService.checkWeeklyInviteLimit(userScore.userId);
      if (atWeeklyLimit) {
        continue;
      }

      // Check recent activity (only invite active users)
      const hasRecentActivity =
        await AlphaGroupInviteService.checkRecentActivity(userScore.userId);
      if (!hasRecentActivity) {
        continue;
      }

      // Get tier-specific invite probability with global multiplier
      const tierConfig = getEffectiveTierConfig(eligibleTier, npc.id);
      const adjustedProbability =
        tierConfig.inviteProbability *
        ALPHA_GROUP_CONFIG.inviteProbabilityMultiplier;

      // Roll the dice
      const roll = Math.random();

      if (roll < adjustedProbability) {
        // User wins! Invite them to appropriate tier
        const result = await TieredGroupService.inviteUserToTier(
          userScore.userId,
          npc.id,
        );

        if (result.success && result.tier !== null) {
          invites.push({
            npcId: npc.id,
            npcName: npc.name,
            userId: userScore.userId,
            invitedToTier: result.tier,
            invitedToChat: result.reason,
            engagementScore: userScore.engagementScore,
            socialScore: userScore.socialScore,
            tradingScore: userScore.tradingScore,
            probability: adjustedProbability,
            fastTracked: userScore.qualifiesForFastTrack,
          });

          logger.info(
            "User invited to alpha group",
            {
              userId: userScore.userId,
              npcId: npc.id,
              npcName: npc.name,
              tier: result.tier,
              engagementScore: userScore.engagementScore,
              socialScore: userScore.socialScore,
              tradingScore: userScore.tradingScore,
              fastTracked: userScore.qualifiesForFastTrack,
              probability: adjustedProbability,
              roll,
            },
            "AlphaGroupInviteService",
          );

          // Only one invite per NPC per tick
          break;
        } else {
          logger.debug(
            "Invite failed",
            {
              userId: userScore.userId,
              npcId: npc.id,
              reason: result.reason,
            },
            "AlphaGroupInviteService",
          );
        }
      }
    }

    return invites;
  }

  /**
   * Get eligible tier considering fast-track and NPC-specific thresholds.
   */
  private static getEligibleTier(
    engagementScore: number,
    npcId: string,
    qualifiesForFastTrack: boolean,
  ): TierLevel | null {
    // Fast-track users can skip to Tier 2 with reduced threshold
    if (qualifiesForFastTrack) {
      const tier2Config = getEffectiveTierConfig(2, npcId);
      // Fast-track users only need 50% of Tier 2 threshold
      if (engagementScore >= tier2Config.minEngagementScore * 0.5) {
        return 2;
      }
      // Fall back to Tier 3 if not quite meeting reduced Tier 2
      return 3;
    }

    // Normal tier calculation with NPC-specific thresholds
    return getTierForEngagementScoreWithNpc(engagementScore, npcId);
  }

  /**
   * Check invite decay status for a user with an NPC.
   */
  private static async checkInviteDecay(
    userId: string,
    npcId: string,
  ): Promise<InviteDecayStatus> {
    // Find declined invites from this NPC's groups to this user
    const declinedInvites = await db
      .select({
        declineCount: groupInvites.declineCount,
        lastDeclinedAt: groupInvites.lastDeclinedAt,
        nextEligibleAt: groupInvites.nextEligibleAt,
      })
      .from(groupInvites)
      .innerJoin(groups, eq(groupInvites.groupId, groups.id))
      .where(
        and(
          eq(groupInvites.invitedUserId, userId),
          eq(groups.ownerId, npcId),
          eq(groupInvites.status, "declined"),
        ),
      )
      .orderBy(desc(groupInvites.lastDeclinedAt))
      .limit(1);

    if (declinedInvites.length === 0) {
      return { canBeInvited: true, declineCount: 0, nextEligibleAt: null };
    }

    const invite = declinedInvites[0]!;
    const { declineCount, lastDeclinedAt, nextEligibleAt } = invite;

    // Check if decline count should be reset due to inactivity
    if (shouldResetDeclineCount(lastDeclinedAt)) {
      return { canBeInvited: true, declineCount: 0, nextEligibleAt: null };
    }

    // Check if exceeded max declines
    if (declineCount >= ALPHA_GROUP_CONFIG.inviteDecayMaxDeclines) {
      return {
        canBeInvited: false,
        declineCount,
        nextEligibleAt: nextEligibleAt,
        reason: `Exceeded max declines (${declineCount}/${ALPHA_GROUP_CONFIG.inviteDecayMaxDeclines})`,
      };
    }

    // Check if still in cooldown
    if (nextEligibleAt && new Date() < nextEligibleAt) {
      return {
        canBeInvited: false,
        declineCount,
        nextEligibleAt,
        reason: `In cooldown until ${nextEligibleAt.toISOString()}`,
      };
    }

    return { canBeInvited: true, declineCount, nextEligibleAt };
  }

  /**
   * Check if user already has membership in any of this NPC's groups.
   */
  private static async checkExistingMembership(
    userId: string,
    npcId: string,
  ): Promise<boolean> {
    const [existing] = await db
      .select({ id: groupMembers.id })
      .from(groupMembers)
      .innerJoin(groups, eq(groupMembers.groupId, groups.id))
      .where(
        and(
          eq(groupMembers.userId, userId),
          eq(groupMembers.isActive, true),
          eq(groups.ownerId, npcId),
        ),
      )
      .limit(1);

    return !!existing;
  }

  /**
   * Check if user is at their NPC group limit.
   */
  private static async checkGroupLimit(userId: string): Promise<boolean> {
    const [result] = await db
      .select({ count: count() })
      .from(groupMembers)
      .innerJoin(groups, eq(groupMembers.groupId, groups.id))
      .where(
        and(
          eq(groupMembers.userId, userId),
          eq(groupMembers.isActive, true),
          eq(groups.type, "npc"),
        ),
      );

    const activeNpcGroups = result?.count ?? 0;

    if (activeNpcGroups >= GROUP_CONFIG.MAX_ACTIVE_USER_GROUPS) {
      logger.debug(
        "User at NPC group limit",
        {
          userId,
          activeNpcGroups,
          maxNpcGroups: GROUP_CONFIG.MAX_ACTIVE_USER_GROUPS,
        },
        "AlphaGroupInviteService",
      );
      return true;
    }

    return false;
  }

  /**
   * Check if user is in invite cooldown (recently joined a group).
   */
  private static async checkCooldown(userId: string): Promise<boolean> {
    const [latestMembership] = await db
      .select({ joinedAt: groupMembers.joinedAt })
      .from(groupMembers)
      .innerJoin(groups, eq(groupMembers.groupId, groups.id))
      .where(
        and(
          eq(groupMembers.userId, userId),
          eq(groupMembers.isActive, true),
          eq(groups.type, "npc"),
        ),
      )
      .orderBy(desc(groupMembers.joinedAt))
      .limit(1);

    if (!latestMembership) {
      return false;
    }

    const hoursSinceJoin =
      (Date.now() - latestMembership.joinedAt.getTime()) / (1000 * 60 * 60);

    if (hoursSinceJoin < ALPHA_GROUP_CONFIG.inviteCooldownHours) {
      logger.debug(
        "User in invite cooldown",
        {
          userId,
          hoursSinceJoin: hoursSinceJoin.toFixed(2),
          cooldownRequired: ALPHA_GROUP_CONFIG.inviteCooldownHours,
        },
        "AlphaGroupInviteService",
      );
      return true;
    }

    return false;
  }

  /**
   * Check if user has exceeded their weekly invite limit.
   * Prevents spamming users with too many invites across all NPCs.
   */
  private static async checkWeeklyInviteLimit(
    userId: string,
  ): Promise<boolean> {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Count invites (pending or accepted) sent to this user in the last week
    const [result] = await db
      .select({ count: count() })
      .from(groupInvites)
      .where(
        and(
          eq(groupInvites.invitedUserId, userId),
          gte(groupInvites.invitedAt, oneWeekAgo),
          or(
            eq(groupInvites.status, "pending"),
            eq(groupInvites.status, "accepted"),
          ),
        ),
      );

    const weeklyInvites = result?.count ?? 0;

    if (weeklyInvites >= ALPHA_GROUP_CONFIG.maxInvitesPerUserPerWeek) {
      logger.debug(
        "User at weekly invite limit",
        {
          userId,
          weeklyInvites,
          maxPerWeek: ALPHA_GROUP_CONFIG.maxInvitesPerUserPerWeek,
        },
        "AlphaGroupInviteService",
      );
      return true;
    }

    return false;
  }

  /**
   * Check if user has had recent activity (within configured days).
   * Prevents inviting inactive/churned users.
   */
  private static async checkRecentActivity(userId: string): Promise<boolean> {
    if (!ALPHA_GROUP_CONFIG.requireRecentActivity) {
      return true; // Activity check disabled
    }

    const activityWindowStart = new Date(
      Date.now() - ALPHA_GROUP_CONFIG.recentActivityDays * 24 * 60 * 60 * 1000,
    );

    // Check for any user interactions in the activity window
    const [result] = await db
      .select({ count: count() })
      .from(userInteractions)
      .where(
        and(
          eq(userInteractions.userId, userId),
          gte(userInteractions.timestamp, activityWindowStart),
        ),
      );

    const recentInteractions = result?.count ?? 0;

    if (recentInteractions === 0) {
      logger.debug(
        "User has no recent activity",
        {
          userId,
          activityWindowDays: ALPHA_GROUP_CONFIG.recentActivityDays,
        },
        "AlphaGroupInviteService",
      );
      return false;
    }

    return true;
  }

  /**
   * Record that a user declined an invite.
   * Updates the invite record with decay tracking.
   */
  static async recordDecline(inviteId: string): Promise<void> {
    const [invite] = await db
      .select({
        declineCount: groupInvites.declineCount,
      })
      .from(groupInvites)
      .where(eq(groupInvites.id, inviteId))
      .limit(1);

    if (!invite) {
      logger.warn(
        "Invite not found for decline recording",
        { inviteId },
        "AlphaGroupInviteService",
      );
      return;
    }

    const newDeclineCount = (invite.declineCount ?? 0) + 1;
    const nextEligibleAt = calculateNextEligibleDate(newDeclineCount);

    await db
      .update(groupInvites)
      .set({
        status: "declined",
        respondedAt: new Date(),
        declineCount: newDeclineCount,
        lastDeclinedAt: new Date(),
        nextEligibleAt,
      })
      .where(eq(groupInvites.id, inviteId));

    logger.info(
      "Invite declined with decay tracking",
      {
        inviteId,
        declineCount: newDeclineCount,
        nextEligibleAt: nextEligibleAt.toISOString(),
      },
      "AlphaGroupInviteService",
    );
  }

  /**
   * Get invite statistics for monitoring and analysis.
   */
  static async getInviteStats(): Promise<{
    totalInvites: number;
    activeGroups: number;
    invitesLast24h: number;
    tierBreakdown: { tier: TierLevel; count: number }[];
  }> {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [totalResult] = await db
      .select({ count: count() })
      .from(groupMembers);

    const [activeResult] = await db
      .select({ count: count() })
      .from(groupMembers)
      .where(eq(groupMembers.isActive, true));

    const [recentResult] = await db
      .select({ count: count() })
      .from(groupMembers)
      .where(gte(groupMembers.joinedAt, oneDayAgo));

    // Get tier breakdown
    const tierCounts = await db
      .select({
        tier: groupMembers.tier,
        count: count(),
      })
      .from(groupMembers)
      .where(eq(groupMembers.isActive, true))
      .groupBy(groupMembers.tier);

    const tierBreakdown: { tier: TierLevel; count: number }[] = [];
    for (const tc of tierCounts) {
      if (tc.tier === 1 || tc.tier === 2 || tc.tier === 3) {
        tierBreakdown.push({ tier: tc.tier as TierLevel, count: tc.count });
      }
    }

    return {
      totalInvites: totalResult?.count ?? 0,
      activeGroups: activeResult?.count ?? 0,
      invitesLast24h: recentResult?.count ?? 0,
      tierBreakdown,
    };
  }

  /**
   * Get detailed analytics for alpha group invites.
   */
  static async getDetailedAnalytics(): Promise<{
    inviteStats: Awaited<
      ReturnType<typeof AlphaGroupInviteService.getInviteStats>
    >;
    declineStats: {
      totalDeclined: number;
      avgDeclineCount: number;
      usersAtMaxDeclines: number;
    };
    configSnapshot: typeof ALPHA_GROUP_CONFIG;
  }> {
    const inviteStats = await AlphaGroupInviteService.getInviteStats();

    // Get decline statistics
    const [declineResult] = await db
      .select({
        count: count(),
      })
      .from(groupInvites)
      .where(eq(groupInvites.status, "declined"));

    const [maxDeclinesResult] = await db
      .select({ count: count() })
      .from(groupInvites)
      .where(
        and(
          eq(groupInvites.status, "declined"),
          gte(
            groupInvites.declineCount,
            ALPHA_GROUP_CONFIG.inviteDecayMaxDeclines,
          ),
        ),
      );

    // Note: Average decline count would require more complex query
    // For now, just return totals

    return {
      inviteStats,
      declineStats: {
        totalDeclined: declineResult?.count ?? 0,
        avgDeclineCount: 0, // Would need aggregation
        usersAtMaxDeclines: maxDeclinesResult?.count ?? 0,
      },
      configSnapshot: ALPHA_GROUP_CONFIG,
    };
  }
}
