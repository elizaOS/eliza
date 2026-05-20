/**
 * Alpha Groups Statistics API
 *
 * @route GET /api/admin/alpha-groups/stats - Get alpha group statistics
 * @access Admin with view_alpha_groups permission
 *
 * @description
 * Returns comprehensive statistics about alpha group invites, tier distribution,
 * engagement metrics, and invite decay status.
 */

import {
  applyRateLimit,
  RATE_LIMIT_CONFIGS,
  rateLimitError,
  requirePermission,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import {
  and,
  count,
  db,
  eq,
  groupInvites,
  groupMembers,
  groups,
  gte,
} from "@feed/db";
import {
  ALPHA_GROUP_CONFIG,
  AlphaGroupInviteService,
  TIER_CONFIG,
  TieredGroupService,
} from "@feed/engine";
import { logger, toISO } from "@feed/shared";
import type { NextRequest } from "next/server";

/**
 * GET /api/admin/alpha-groups/stats
 *
 * Returns alpha group statistics including:
 * - Invite metrics (total, accepted, declined, pending)
 * - Tier distribution across all NPC groups
 * - Grandfathered member counts
 * - Invite decay statistics
 * - Recent invite activity
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const admin = await requirePermission(request, "view_alpha_groups");

  // Apply rate limiting
  const rateLimitResult = applyRateLimit(
    admin.userId,
    RATE_LIMIT_CONFIGS.ADMIN_STATS,
  );
  if (!rateLimitResult.allowed) {
    return rateLimitError(rateLimitResult.retryAfter);
  }

  logger.info(
    "Alpha group stats requested",
    { adminUserId: admin.userId },
    "GET /api/admin/alpha-groups/stats",
  );

  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Run all queries in parallel
  const [
    // Get global tier analytics from TieredGroupService
    globalAnalytics,
    // Invite stats from AlphaGroupInviteService
    inviteStats,
    // Invite status counts
    pendingInvites,
    acceptedInvites,
    declinedInvites,
    // Grandfathered counts
    grandfatheredMembers,
    // Invite decay stats
    usersWithDeclines,
    usersAtMaxDeclines,
    // Active memberships by tier
    tier1Members,
    tier2Members,
    tier3Members,
    // Recent activity
    invitesLast24h,
    invitesLastWeek,
    joinsLast24h,
    joinsLastWeek,
  ] = await Promise.all([
    TieredGroupService.getGlobalAnalytics(),
    AlphaGroupInviteService.getInviteStats(),
    // Pending invites
    db
      .select({ count: count() })
      .from(groupInvites)
      .where(eq(groupInvites.status, "pending"))
      .then((r) => r[0]?.count ?? 0),
    // Accepted invites
    db
      .select({ count: count() })
      .from(groupInvites)
      .where(eq(groupInvites.status, "accepted"))
      .then((r) => r[0]?.count ?? 0),
    // Declined invites
    db
      .select({ count: count() })
      .from(groupInvites)
      .where(eq(groupInvites.status, "declined"))
      .then((r) => r[0]?.count ?? 0),
    // Grandfathered members
    db
      .select({ count: count() })
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.isActive, true),
          eq(groupMembers.isGrandfathered, true),
        ),
      )
      .then((r) => r[0]?.count ?? 0),
    // Users with declines
    db
      .select({ count: count() })
      .from(groupInvites)
      .where(gte(groupInvites.declineCount, 1))
      .then((r) => r[0]?.count ?? 0),
    // Users at max declines
    db
      .select({ count: count() })
      .from(groupInvites)
      .where(
        gte(
          groupInvites.declineCount,
          ALPHA_GROUP_CONFIG.inviteDecayMaxDeclines,
        ),
      )
      .then((r) => r[0]?.count ?? 0),
    // Tier 1 members
    db
      .select({ count: count() })
      .from(groupMembers)
      .innerJoin(groups, eq(groupMembers.groupId, groups.id))
      .where(
        and(
          eq(groupMembers.isActive, true),
          eq(groups.type, "npc"),
          eq(groupMembers.tier, 1),
        ),
      )
      .then((r) => r[0]?.count ?? 0),
    // Tier 2 members
    db
      .select({ count: count() })
      .from(groupMembers)
      .innerJoin(groups, eq(groupMembers.groupId, groups.id))
      .where(
        and(
          eq(groupMembers.isActive, true),
          eq(groups.type, "npc"),
          eq(groupMembers.tier, 2),
        ),
      )
      .then((r) => r[0]?.count ?? 0),
    // Tier 3 members
    db
      .select({ count: count() })
      .from(groupMembers)
      .innerJoin(groups, eq(groupMembers.groupId, groups.id))
      .where(
        and(
          eq(groupMembers.isActive, true),
          eq(groups.type, "npc"),
          eq(groupMembers.tier, 3),
        ),
      )
      .then((r) => r[0]?.count ?? 0),
    // Invites in last 24h
    db
      .select({ count: count() })
      .from(groupInvites)
      .where(gte(groupInvites.invitedAt, oneDayAgo))
      .then((r) => r[0]?.count ?? 0),
    // Invites in last week
    db
      .select({ count: count() })
      .from(groupInvites)
      .where(gte(groupInvites.invitedAt, oneWeekAgo))
      .then((r) => r[0]?.count ?? 0),
    // Joins in last 24h
    db
      .select({ count: count() })
      .from(groupMembers)
      .innerJoin(groups, eq(groupMembers.groupId, groups.id))
      .where(and(eq(groups.type, "npc"), gte(groupMembers.joinedAt, oneDayAgo)))
      .then((r) => r[0]?.count ?? 0),
    // Joins in last week
    db
      .select({ count: count() })
      .from(groupMembers)
      .innerJoin(groups, eq(groupMembers.groupId, groups.id))
      .where(
        and(eq(groups.type, "npc"), gte(groupMembers.joinedAt, oneWeekAgo)),
      )
      .then((r) => r[0]?.count ?? 0),
  ]);

  // Calculate acceptance rate
  const totalResponded = acceptedInvites + declinedInvites;
  const acceptanceRate =
    totalResponded > 0 ? acceptedInvites / totalResponded : 0;

  // Calculate tier capacities
  const tierCapacities = {
    1: {
      name: TIER_CONFIG[1].name,
      current: tier1Members,
      max:
        globalAnalytics.tierBreakdown.find((t) => t.tier === 1)?.capacity ?? 0,
      fillRate:
        tier1Members /
        (globalAnalytics.tierBreakdown.find((t) => t.tier === 1)?.capacity ||
          1),
    },
    2: {
      name: TIER_CONFIG[2].name,
      current: tier2Members,
      max:
        globalAnalytics.tierBreakdown.find((t) => t.tier === 2)?.capacity ?? 0,
      fillRate:
        tier2Members /
        (globalAnalytics.tierBreakdown.find((t) => t.tier === 2)?.capacity ||
          1),
    },
    3: {
      name: TIER_CONFIG[3].name,
      current: tier3Members,
      max:
        globalAnalytics.tierBreakdown.find((t) => t.tier === 3)?.capacity ?? 0,
      fillRate:
        tier3Members /
        (globalAnalytics.tierBreakdown.find((t) => t.tier === 3)?.capacity ||
          1),
    },
  };

  return successResponse({
    success: true,
    data: {
      overview: {
        totalNpcs: globalAnalytics.totalNpcs,
        totalGroups: globalAnalytics.totalGroups,
        totalMembers: globalAnalytics.totalMembers,
        totalCapacity: globalAnalytics.totalCapacity,
        overallFillRate: globalAnalytics.fillRate,
      },
      invites: {
        total: inviteStats.totalInvites,
        pending: pendingInvites,
        accepted: acceptedInvites,
        declined: declinedInvites,
        acceptanceRate,
        last24h: invitesLast24h,
        lastWeek: invitesLastWeek,
      },
      joins: {
        last24h: joinsLast24h,
        lastWeek: joinsLastWeek,
      },
      tiers: tierCapacities,
      tierBreakdown: globalAnalytics.tierBreakdown,
      grandfathering: {
        grandfatheredMembers,
        grandfatheringEnabled: ALPHA_GROUP_CONFIG.grandfatheringEnabled,
      },
      inviteDecay: {
        enabled: ALPHA_GROUP_CONFIG.inviteDecayEnabled,
        usersWithDeclines,
        usersAtMaxDeclines,
        maxDeclines: ALPHA_GROUP_CONFIG.inviteDecayMaxDeclines,
        baseHours: ALPHA_GROUP_CONFIG.inviteDecayBaseHours,
        maxHours: ALPHA_GROUP_CONFIG.inviteDecayMaxHours,
      },
      config: {
        inviteProbabilityMultiplier:
          ALPHA_GROUP_CONFIG.inviteProbabilityMultiplier,
        maxInvitesPerTick: ALPHA_GROUP_CONFIG.maxInvitesPerTick,
        inviteCooldownHours: ALPHA_GROUP_CONFIG.inviteCooldownHours,
        fastTrackEnabled: ALPHA_GROUP_CONFIG.fastTrackEnabled,
        includeTradingActivity: ALPHA_GROUP_CONFIG.includeTradingActivity,
        perNpcCustomizationEnabled:
          ALPHA_GROUP_CONFIG.perNpcCustomizationEnabled,
      },
      thresholds: {
        minReplies: ALPHA_GROUP_CONFIG.minReplies,
        minLikes: ALPHA_GROUP_CONFIG.minLikes,
        minTotalInteractions: ALPHA_GROUP_CONFIG.minTotalInteractions,
        minQualityScore: ALPHA_GROUP_CONFIG.minQualityScore,
      },
      timestamp: toISO(now),
    },
  });
});
