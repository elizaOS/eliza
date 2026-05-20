/**
 * Alpha Groups Admin Tab
 *
 * @description Tab component for monitoring and managing alpha group dynamics.
 * Displays invitation statistics, tier distribution, configuration,
 * and recent activity for NPC alpha groups.
 *
 * @component AlphaGroupsTab
 * @access Admin with view_alpha_groups permission
 */

"use client";

import { cn } from "@feed/shared";
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Crown,
  RefreshCw,
  Settings,
  Shield,
  TrendingUp,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { apiUrl } from "@/utils/api-url";

/**
 * Zod schema for tier statistics.
 */
const TierStatsSchema = z.object({
  name: z.string(),
  current: z.number(),
  max: z.number(),
  fillRate: z.number(),
});

/**
 * Zod schema for invite stats.
 */
const InviteStatsSchema = z.object({
  total: z.number(),
  pending: z.number(),
  accepted: z.number(),
  declined: z.number(),
  acceptanceRate: z.number(),
  last24h: z.number(),
  lastWeek: z.number(),
});

/**
 * Zod schema for the full stats response.
 */
const AlphaGroupStatsSchema = z.object({
  success: z.boolean(),
  data: z.object({
    overview: z.object({
      totalNpcs: z.number(),
      totalGroups: z.number(),
      totalMembers: z.number(),
      totalCapacity: z.number(),
      overallFillRate: z.number(),
    }),
    invites: InviteStatsSchema,
    joins: z.object({
      last24h: z.number(),
      lastWeek: z.number(),
    }),
    tiers: z.record(z.string(), TierStatsSchema),
    grandfathering: z.object({
      grandfatheredMembers: z.number(),
      grandfatheringEnabled: z.boolean(),
    }),
    inviteDecay: z.object({
      enabled: z.boolean(),
      usersWithDeclines: z.number(),
      usersAtMaxDeclines: z.number(),
      maxDeclines: z.number(),
      baseHours: z.number(),
      maxHours: z.number(),
    }),
    config: z.object({
      inviteProbabilityMultiplier: z.number(),
      maxInvitesPerTick: z.number(),
      inviteCooldownHours: z.number(),
      fastTrackEnabled: z.boolean(),
      includeTradingActivity: z.boolean(),
      perNpcCustomizationEnabled: z.boolean(),
    }),
    thresholds: z.object({
      minReplies: z.number(),
      minLikes: z.number(),
      minTotalInteractions: z.number(),
      minQualityScore: z.number(),
    }),
    timestamp: z.string(),
  }),
});

type AlphaGroupStats = z.infer<typeof AlphaGroupStatsSchema>["data"];

/**
 * Zod schema for config response.
 */
const AlphaGroupConfigSchema = z.object({
  success: z.boolean(),
  data: z.object({
    config: z.record(
      z.string(),
      z.union([z.number(), z.boolean(), z.object({}).passthrough()]),
    ),
    tierConfig: z.record(
      z.string(),
      z.object({
        name: z.string(),
        minEngagementScore: z.number(),
        inviteProbability: z.number(),
        maxMembers: z.number(),
        alphaLevel: z.string(),
        promotionWaitDays: z.number(),
        demotionInactiveDays: z.number(),
      }),
    ),
    instructions: z.object({
      howToUpdate: z.string(),
      effectiveImmediately: z.string(),
      documentation: z.string(),
    }),
  }),
});

type AlphaGroupConfig = z.infer<typeof AlphaGroupConfigSchema>["data"];

/**
 * Format percentage for display.
 */
function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Get color class based on fill rate.
 */
function getFillRateColor(rate: number): string {
  if (rate < 0.5) return "text-green-400";
  if (rate < 0.75) return "text-yellow-400";
  if (rate < 0.9) return "text-orange-400";
  return "text-red-400";
}

/**
 * Get color class for tier.
 */
function getTierColor(tier: string): string {
  switch (tier) {
    case "1":
      return "bg-purple-600/20 text-purple-300 border-purple-500";
    case "2":
      return "bg-blue-600/20 text-blue-300 border-blue-500";
    case "3":
      return "bg-green-600/20 text-green-300 border-green-500";
    default:
      return "bg-gray-600/20 text-gray-300 border-gray-500";
  }
}

export function AlphaGroupsTab() {
  const [stats, setStats] = useState<AlphaGroupStats | null>(null);
  const [config, setConfig] = useState<AlphaGroupConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  /**
   * Fetch alpha group statistics.
   */
  const fetchStats = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    const response = await fetch(apiUrl("/api/admin/alpha-groups/stats"), {
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      setError(`Failed to fetch stats: ${response.status} - ${errorText}`);
      setIsLoading(false);
      return;
    }

    const json = await response.json();
    const parsed = AlphaGroupStatsSchema.safeParse(json);

    if (!parsed.success) {
      setError(`Invalid response format: ${parsed.error.message}`);
      setIsLoading(false);
      return;
    }

    setStats(parsed.data.data);
    setIsLoading(false);
  }, []);

  /**
   * Fetch alpha group configuration.
   */
  const fetchConfig = useCallback(async () => {
    const response = await fetch(apiUrl("/api/admin/alpha-groups/config"), {
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return;
    }

    const json = await response.json();
    const parsed = AlphaGroupConfigSchema.safeParse(json);

    if (parsed.success) {
      setConfig(parsed.data.data);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    fetchConfig();
  }, [fetchStats, fetchConfig]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Loading alpha group data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center text-center">
        <Shield className="mb-4 h-12 w-12 text-destructive" />
        <h2 className="font-semibold text-destructive text-xl">Error</h2>
        <p className="max-w-md text-muted-foreground">{error}</p>
        <button
          onClick={fetchStats}
          className="mt-4 rounded-lg bg-primary px-6 py-2 text-primary-foreground hover:bg-primary/90"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!stats) {
    return null;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Crown className="h-6 w-6 text-primary" />
          <div>
            <h2 className="font-semibold text-lg">Alpha Group Dynamics</h2>
            <p className="text-muted-foreground text-sm">
              Monitor NPC group invite thresholds and activity
            </p>
          </div>
        </div>
        <button
          onClick={() => {
            fetchStats();
            fetchConfig();
          }}
          className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm hover:bg-muted"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary/10 p-2">
              <Users className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-muted-foreground text-sm">Total Members</p>
              <p className="font-bold text-xl">{stats.overview.totalMembers}</p>
            </div>
          </div>
          <p className="mt-2 text-muted-foreground text-xs">
            of {stats.overview.totalCapacity} capacity (
            {formatPercent(stats.overview.overallFillRate)})
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-green-500/10 p-2">
              <TrendingUp className="h-5 w-5 text-green-500" />
            </div>
            <div>
              <p className="text-muted-foreground text-sm">Joins (24h)</p>
              <p className="font-bold text-xl">{stats.joins.last24h}</p>
            </div>
          </div>
          <p className="mt-2 text-muted-foreground text-xs">
            {stats.joins.lastWeek} in last 7 days
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-purple-500/10 p-2">
              <Activity className="h-5 w-5 text-purple-500" />
            </div>
            <div>
              <p className="text-muted-foreground text-sm">Invites (24h)</p>
              <p className="font-bold text-xl">{stats.invites.last24h}</p>
            </div>
          </div>
          <p className="mt-2 text-muted-foreground text-xs">
            {formatPercent(stats.invites.acceptanceRate)} acceptance rate
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-yellow-500/10 p-2">
              <Crown className="h-5 w-5 text-yellow-500" />
            </div>
            <div>
              <p className="text-muted-foreground text-sm">NPC Groups</p>
              <p className="font-bold text-xl">{stats.overview.totalGroups}</p>
            </div>
          </div>
          <p className="mt-2 text-muted-foreground text-xs">
            across {stats.overview.totalNpcs} NPCs
          </p>
        </div>
      </div>

      {/* Tier Distribution */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="mb-4 font-semibold">Tier Distribution</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {Object.entries(stats.tiers).map(([tierId, tier]) => (
            <div
              key={tierId}
              className={cn("rounded-lg border p-4", getTierColor(tierId))}
            >
              <div className="flex items-center justify-between">
                <h4 className="font-semibold">{tier.name}</h4>
                <span className="text-sm opacity-70">Tier {tierId}</span>
              </div>
              <div className="mt-2">
                <div className="flex items-end justify-between">
                  <span className="font-bold text-2xl">{tier.current}</span>
                  <span className="text-sm opacity-70">/ {tier.max}</span>
                </div>
                <div className="mt-2 h-2 rounded-full bg-background/30">
                  <div
                    className={cn(
                      "h-2 rounded-full",
                      tier.fillRate < 0.75
                        ? "bg-green-500"
                        : tier.fillRate < 0.9
                          ? "bg-yellow-500"
                          : "bg-red-500",
                    )}
                    style={{
                      width: `${Math.min(100, tier.fillRate * 100)}%`,
                    }}
                  />
                </div>
                <p
                  className={cn(
                    "mt-1 text-sm",
                    getFillRateColor(tier.fillRate),
                  )}
                >
                  {formatPercent(tier.fillRate)} full
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Invite Statistics */}
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="mb-4 font-semibold">Invite Statistics</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Total Invites</span>
              <span className="font-semibold">{stats.invites.total}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Pending</span>
              <span className="font-semibold text-yellow-500">
                {stats.invites.pending}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Accepted</span>
              <span className="font-semibold text-green-500">
                {stats.invites.accepted}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Declined</span>
              <span className="font-semibold text-red-500">
                {stats.invites.declined}
              </span>
            </div>
            <div className="border-border border-t pt-3">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Acceptance Rate</span>
                <span className="font-semibold text-primary">
                  {formatPercent(stats.invites.acceptanceRate)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Invite Decay & Grandfathering */}
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Invite Decay</h3>
              <span
                className={cn(
                  "rounded-full px-2 py-1 text-xs",
                  stats.inviteDecay.enabled
                    ? "bg-green-500/10 text-green-500"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {stats.inviteDecay.enabled ? "Enabled" : "Disabled"}
              </span>
            </div>
            {stats.inviteDecay.enabled && (
              <div className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Users w/ Declines
                  </span>
                  <span>{stats.inviteDecay.usersWithDeclines}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">At Max Declines</span>
                  <span className="text-red-500">
                    {stats.inviteDecay.usersAtMaxDeclines}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Cooldown Range</span>
                  <span>
                    {stats.inviteDecay.baseHours}h -{" "}
                    {stats.inviteDecay.maxHours}h
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Grandfathering</h3>
              <span
                className={cn(
                  "rounded-full px-2 py-1 text-xs",
                  stats.grandfathering.grandfatheringEnabled
                    ? "bg-green-500/10 text-green-500"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {stats.grandfathering.grandfatheringEnabled
                  ? "Enabled"
                  : "Disabled"}
              </span>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              <span className="font-bold text-xl">
                {stats.grandfathering.grandfatheredMembers}
              </span>
              <span className="text-muted-foreground text-sm">
                protected members
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Configuration Panel */}
      <div className="rounded-xl border border-border bg-card">
        <button
          onClick={() => setShowConfig(!showConfig)}
          className="flex w-full items-center justify-between p-4 text-left hover:bg-muted/50"
        >
          <div className="flex items-center gap-3">
            <Settings className="h-5 w-5 text-muted-foreground" />
            <div>
              <h3 className="font-semibold">Configuration</h3>
              <p className="text-muted-foreground text-sm">
                Current thresholds and settings
              </p>
            </div>
          </div>
          {showConfig ? (
            <ChevronUp className="h-5 w-5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-5 w-5 text-muted-foreground" />
          )}
        </button>

        {showConfig && config && (
          <div className="border-border border-t p-4">
            {/* Thresholds */}
            <div className="mb-4">
              <h4 className="mb-3 font-medium text-sm">
                Eligibility Thresholds
              </h4>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg bg-muted p-3">
                  <p className="text-muted-foreground text-xs">Min Replies</p>
                  <p className="font-bold text-lg">
                    {stats.thresholds.minReplies}
                  </p>
                </div>
                <div className="rounded-lg bg-muted p-3">
                  <p className="text-muted-foreground text-xs">Min Likes</p>
                  <p className="font-bold text-lg">
                    {stats.thresholds.minLikes}
                  </p>
                </div>
                <div className="rounded-lg bg-muted p-3">
                  <p className="text-muted-foreground text-xs">Min Total</p>
                  <p className="font-bold text-lg">
                    {stats.thresholds.minTotalInteractions}
                  </p>
                </div>
                <div className="rounded-lg bg-muted p-3">
                  <p className="text-muted-foreground text-xs">Min Quality</p>
                  <p className="font-bold text-lg">
                    {stats.thresholds.minQualityScore}
                  </p>
                </div>
              </div>
            </div>

            {/* Feature Flags */}
            <div>
              <h4 className="mb-3 font-medium text-sm">Feature Flags</h4>
              <div className="flex flex-wrap gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "h-2.5 w-2.5 rounded-full",
                      stats.config.fastTrackEnabled
                        ? "bg-green-500"
                        : "bg-muted-foreground",
                    )}
                  />
                  <span className="text-sm">Fast Track</span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "h-2.5 w-2.5 rounded-full",
                      stats.config.includeTradingActivity
                        ? "bg-green-500"
                        : "bg-muted-foreground",
                    )}
                  />
                  <span className="text-sm">Trading Activity</span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "h-2.5 w-2.5 rounded-full",
                      stats.config.perNpcCustomizationEnabled
                        ? "bg-green-500"
                        : "bg-muted-foreground",
                    )}
                  />
                  <span className="text-sm">Per-NPC Customization</span>
                </div>
              </div>
            </div>

            {/* Instructions */}
            <div className="mt-4 rounded-lg bg-muted p-3">
              <p className="font-medium text-sm text-yellow-600 dark:text-yellow-400">
                How to Update
              </p>
              <p className="mt-1 text-muted-foreground text-sm">
                {config.instructions.howToUpdate}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Timestamp */}
      <p className="text-center text-muted-foreground text-xs">
        Last updated: {new Date(stats.timestamp).toLocaleString()}
      </p>
    </div>
  );
}
