/**
 * Server actions for dashboard data.
 */

"use server";

import { organizationsRepository } from "@/db/repositories/organizations";
import { requireAuthWithOrg } from "@/lib/auth";
import { cache as cacheClient } from "@/lib/cache/client";
import { CacheKeys, CacheStaleTTL } from "@/lib/cache/keys";
import { roomsService } from "@/lib/services/agents/rooms";
import { apiKeysService } from "@/lib/services/api-keys";
import { appsService } from "@/lib/services/apps";
import { charactersService } from "@/lib/services/characters/characters";
import { characterDeploymentDiscoveryService } from "@/lib/services/deployments";
import { generationsService } from "@/lib/services/generations";
import { usageService } from "@/lib/services/usage";
import type { DashboardAgentStats } from "@/lib/types/dashboard-agent-stats";
import { logger } from "@/lib/utils/logger";

export type { DashboardAgentStats };

/**
 * Complete dashboard data for a user's organization.
 */
export interface DashboardData {
  user: {
    name: string;
  };
  stats: {
    totalGenerations: number;
    apiCalls24h: number;
    imageGenerations: number;
    videoGenerations: number;
    creditBalance: number;
  };
  onboarding: {
    hasAgents: boolean;
    hasApiKey: boolean;
    hasChatHistory: boolean;
  };
  agents: Array<{
    id: string;
    name: string;
    bio: string | string[];
    avatarUrl: string | null;
    category: string | null;
    isPublic: boolean;
    stats?: DashboardAgentStats;
  }>;
  containers: Array<{
    id: string;
    name: string;
    description: string | null;
    status: string;
    load_balancer_url: string | null;
    port: number;
    desired_count: number;
    cpu: number;
    memory: number;
    last_deployed_at: Date | null;
    created_at: Date;
    error_message: string | null;
  }>;
  apps: Array<{
    id: string;
    name: string;
    description: string | null;
    slug: string;
    app_url: string;
    logo_url: string | null;
    is_active: boolean;
    total_users: number;
    total_requests: number;
    last_used_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>;
  creditBalance: number;
}

/**
 * Fetches the credit balance for an organization.
 */
async function getCreditBalance(organizationId: string): Promise<number> {
  try {
    const org = await organizationsRepository.findById(organizationId);
    return org ? Number(org.credit_balance) : 0;
  } catch {
    return 0;
  }
}

/**
 * Internal function to fetch dashboard data (not cached at React level).
 *
 * @param user - Authenticated user with organization.
 * @returns Dashboard data including stats and agents.
 */
async function fetchDashboardDataInternal(
  user: Awaited<ReturnType<typeof requireAuthWithOrg>>,
): Promise<DashboardData> {
  const organizationId = user.organization_id!;

  // Fetch only the data rendered on the dashboard home.
  const [generationStats, userCharacters, apiKeys, userRooms, apps, org] = await Promise.all([
    generationsService.getStats(organizationId),
    charactersService.listByUser(user.id),
    apiKeysService.listByOrganization(organizationId),
    roomsService.getRoomsForEntity(user.id),
    appsService.listByOrganization(organizationId),
    organizationsRepository.findById(organizationId),
  ]);

  const chatRoomCount = userRooms.length;

  const totalGenerations = generationStats.totalGenerations;
  const imageGenerations = generationStats.byType.find((t) => t.type === "image")?.count || 0;
  const videoGenerations = generationStats.byType.find((t) => t.type === "video")?.count || 0;

  // Get actual 24h API call count from usage records
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const usageStats = await usageService.getStatsByOrganization(
    organizationId,
    twentyFourHoursAgo,
    new Date(),
  );
  const apiCalls24h = usageStats.totalRequests;

  // Fetch agent stats in batch
  const characterIds = userCharacters.map((c) => c.id);
  const agentStatsMap = new Map<string, DashboardAgentStats>();

  if (characterIds.length > 0) {
    try {
      const statsMap =
        await characterDeploymentDiscoveryService.getCharacterStatisticsBatch(characterIds);
      statsMap.forEach((stats, id) => {
        // Note: Both `status` (from AgentStats) and `deploymentStatus` (added by DashboardAgentStats)
        // are required - they have the same value but satisfy different type requirements
        agentStatsMap.set(id, {
          roomCount: stats.roomCount,
          messageCount: stats.messageCount,
          status: stats.status,
          deploymentStatus: stats.status,
          lastActiveAt: stats.lastActiveAt,
        });
      });
    } catch (error) {
      logger.error("[getDashboardData] Failed to fetch agent stats:", error);
    }
  }

  return {
    user: {
      name: user.name || "User",
    },
    stats: {
      totalGenerations,
      apiCalls24h,
      imageGenerations,
      videoGenerations,
      creditBalance: org ? Number(org.credit_balance) : 0,
    },
    onboarding: {
      hasAgents: userCharacters.length > 0,
      hasApiKey: apiKeys.some(
        (key) => key.name !== "Default API Key" || (key.usage_count ?? 0) > 0,
      ),
      hasChatHistory: chatRoomCount > 0,
    },
    agents: userCharacters.map((c) => ({
      id: c.id,
      name: c.name,
      bio: c.bio,
      avatarUrl: c.avatar_url || null,
      category: c.category || null,
      isPublic: c.is_public,
      stats: agentStatsMap.get(c.id),
    })),
    containers: [],
    apps: apps.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      slug: a.slug,
      app_url: a.app_url,
      logo_url: a.logo_url,
      is_active: a.is_active,
      total_users: a.total_users,
      total_requests: a.total_requests,
      last_used_at: a.last_used_at,
      created_at: a.created_at,
      updated_at: a.updated_at,
    })),
    creditBalance: await getCreditBalance(organizationId),
  };
}

/**
 * Gets dashboard data for the current user's organization.
 *
 * SWR caching is keyed by organization in Redis.
 *
 * @returns Dashboard data including stats and agents.
 */
export async function getDashboardData(request: Request): Promise<DashboardData> {
  const user = await requireAuthWithOrg(request);
  const organizationId = user.organization_id!;
  const cacheKey = CacheKeys.org.dashboard(organizationId);

  // Use stale-while-revalidate pattern
  const data = await cacheClient.getWithSWR(cacheKey, CacheStaleTTL.org.dashboard, () =>
    fetchDashboardDataInternal(user),
  );

  // Fallback to direct fetch if cache returns null
  if (data === null) {
    return await fetchDashboardDataInternal(user);
  }

  // Handle cached data that doesn't have apps field (migration from old cache)
  if (!data.apps) {
    const apps = await appsService.listByOrganization(organizationId);
    data.apps = apps.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      slug: a.slug,
      app_url: a.app_url,
      logo_url: a.logo_url,
      is_active: a.is_active,
      total_users: a.total_users,
      total_requests: a.total_requests,
      last_used_at: a.last_used_at,
      created_at: a.created_at,
      updated_at: a.updated_at,
    }));
  }

  return data;
}
