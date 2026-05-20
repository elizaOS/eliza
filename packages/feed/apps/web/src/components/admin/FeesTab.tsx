'use client';

import {
  FEED_POINTS_SYMBOL,
  cn,
  formatCompactCurrency,
} from '@feed/shared';
import { Award, DollarSign, RefreshCw, TrendingUp, Users } from 'lucide-react';
import { useCallback, useEffect, useState, useTransition } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { z } from 'zod';
import { Avatar } from '@/components/shared/Avatar';
import { Skeleton } from '@/components/shared/Skeleton';
import { apiUrl } from '@/utils/api-url';

/**
 * Fee statistics schema for validation.
 */
const FeeStatsSchema = z.object({
  platformStats: z.object({
    totalFeesCollected: z.number(),
    totalUserFees: z.number(),
    totalNPCFees: z.number(),
    totalPlatformFees: z.number(),
    totalReferrerFees: z.number(),
    totalTrades: z.number(),
  }),
  feesByType: z.array(
    z.object({
      tradeType: z.string(),
      totalFees: z.number(),
      platformFees: z.number(),
      referrerFees: z.number(),
      tradeCount: z.number(),
    })
  ),
  topFeePayers: z.array(
    z.object({
      userId: z.string(),
      username: z.string(),
      displayName: z.string(),
      profileImageUrl: z.string().nullable(),
      isNPC: z.boolean(),
      totalFees: z.number(),
      tradeCount: z.number(),
    })
  ),
  topReferralEarners: z.array(
    z.object({
      userId: z.string(),
      username: z.string(),
      displayName: z.string(),
      profileImageUrl: z.string().nullable(),
      totalEarned: z.number(),
      referralCount: z.number(),
    })
  ),
  recentFees: z.array(
    z.object({
      id: z.string(),
      userId: z.string(),
      username: z.string(),
      displayName: z.string(),
      profileImageUrl: z.string().nullable(),
      isNPC: z.boolean(),
      tradeType: z.string(),
      feeAmount: z.number(),
      platformFee: z.number(),
      referrerFee: z.number(),
      createdAt: z.string(),
    })
  ),
  feeTrend: z.array(
    z.object({
      date: z.string(),
      totalFees: z.number(),
      tradeCount: z.number(),
    })
  ),
});
type FeeStats = z.infer<typeof FeeStatsSchema>;

/**
 * Fees tab component for displaying fee collection statistics.
 *
 * Displays comprehensive fee statistics including platform fees, user fees,
 * NPC fees, referrer fees, and fee trends. Shows top fee payers, top referral
 * earners, and recent fees. Includes charts for fee trends over time.
 *
 * Features:
 * - Fee statistics dashboard
 * - Fee breakdown by type
 * - Top fee payers list
 * - Top referral earners list
 * - Recent fees list
 * - Fee trend charts
 * - Loading states
 * - Error handling
 *
 * @returns Fees tab element
 */
export function FeesTab() {
  const [stats, setStats] = useState<FeeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, startRefresh] = useTransition();

  const fetchStats = useCallback(() => {
    startRefresh(async () => {
      const response = await fetch(apiUrl('/api/admin/fees'));
      if (!response.ok) {
        throw new Error(`Failed to fetch fee statistics: ${response.status}`);
      }
      const data = await response.json();
      const validated = FeeStatsSchema.parse(data);
      setStats(validated);
      setError(null);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  /** Use shared formatCompactCurrency for currency formatting */
  const formatCurrency = formatCompactCurrency;

  const formatNumber = (value: number) => {
    if (value >= 1000000) return `${(value / 1000000).toFixed(2)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(2)}K`;
    return value.toLocaleString();
  };

  const formatTradeType = (type: string) => {
    const typeMap: Record<string, string> = {
      pred_buy: 'Prediction Buy',
      pred_sell: 'Prediction Sell',
      perp_open: 'Perp Open',
      perp_close: 'Perp Close',
      npc_pred_buy: 'NPC Prediction Buy',
      npc_pred_sell: 'NPC Prediction Sell',
      npc_perp_open: 'NPC Perp Open',
      npc_perp_close: 'NPC Perp Close',
    };
    return typeMap[type] || type;
  };

  const StatCard = ({
    icon: Icon,
    label,
    value,
    subtitle,
    color = 'primary',
  }: {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    value: string | number;
    subtitle?: string;
    color?: 'primary' | 'green' | 'blue' | 'orange' | 'purple';
  }) => {
    const colorClasses = {
      primary: 'text-primary',
      green: 'text-green-500',
      blue: 'text-blue-500',
      orange: 'text-orange-500',
      purple: 'text-purple-500',
    };

    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-2 flex items-center gap-3">
          <Icon className={cn('h-5 w-5', colorClasses[color])} />
          <span className="text-muted-foreground text-sm">{label}</span>
        </div>
        <div className="font-bold text-2xl">{value}</div>
        {subtitle && (
          <div className="mt-1 text-muted-foreground text-xs">{subtitle}</div>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="p-8 text-center text-red-500">
        {error || 'Failed to load fee statistics'}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with Refresh Button */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-bold text-2xl">Fee Statistics</h2>
          <p className="text-muted-foreground text-sm">
            Platform-wide trading fee analytics
          </p>
        </div>
        <button
          onClick={fetchStats}
          disabled={isRefreshing}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          <RefreshCw
            className={cn('h-4 w-4', isRefreshing && 'animate-spin')}
          />
          Refresh
        </button>
      </div>

      {/* Overview Stats */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={DollarSign}
          label="Total Fees Collected"
          value={formatCurrency(stats.platformStats.totalFeesCollected)}
          subtitle={`${formatNumber(stats.platformStats.totalTrades)} trades`}
          color="green"
        />
        <StatCard
          icon={TrendingUp}
          label="Platform Revenue"
          value={formatCurrency(stats.platformStats.totalPlatformFees)}
          subtitle="50% of fees"
          color="blue"
        />
        <StatCard
          icon={Award}
          label="Referral Payouts"
          value={formatCurrency(stats.platformStats.totalReferrerFees)}
          subtitle="50% of fees"
          color="orange"
        />
        <StatCard
          icon={Users}
          label="Average Fee/Trade"
          value={formatCurrency(
            stats.platformStats.totalTrades > 0
              ? stats.platformStats.totalFeesCollected /
                  stats.platformStats.totalTrades
              : 0
          )}
          subtitle="0.1% fee rate"
          color="purple"
        />
      </div>

      {/* Fee Trend Chart */}
      <div className="rounded-lg border border-border bg-card p-6">
        <h3 className="mb-4 font-semibold text-lg">Fee Trend (Last 30 Days)</h3>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={stats.feeTrend}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis
              dataKey="date"
              stroke="#888"
              fontSize={12}
              tickFormatter={(date) =>
                new Date(date).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                })
              }
            />
            <YAxis
              stroke="#888"
              fontSize={12}
              tickFormatter={(value) => `${FEED_POINTS_SYMBOL}${value}`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1a1a1a',
                border: '1px solid #333',
              }}
              labelFormatter={(date) => new Date(date).toLocaleDateString()}
              formatter={(value) => {
                const numericValue = Array.isArray(value)
                  ? Number(value[0] ?? 0)
                  : Number(value ?? 0);
                return [
                  `${FEED_POINTS_SYMBOL}${numericValue.toFixed(2)}`,
                  'Fees',
                ];
              }}
            />
            <Line
              type="monotone"
              dataKey="totalFees"
              stroke="#22c55e"
              strokeWidth={2}
              dot={{ fill: '#22c55e', r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Fee Breakdown by Type */}
      <div className="rounded-lg border border-border bg-card p-6">
        <h3 className="mb-4 font-semibold text-lg">Fees by Trade Type</h3>
        <div className="space-y-3">
          {stats.feesByType.map((item) => (
            <div
              key={item.tradeType}
              className="flex items-center justify-between rounded-lg bg-accent/20 p-3"
            >
              <div className="flex-1">
                <div className="font-medium">
                  {formatTradeType(item.tradeType)}
                </div>
                <div className="text-muted-foreground text-sm">
                  {formatNumber(item.tradeCount)} trades
                </div>
              </div>
              <div className="text-right">
                <div className="font-bold text-green-500">
                  {formatCurrency(item.totalFees)}
                </div>
                <div className="text-muted-foreground text-xs">
                  Platform: {formatCurrency(item.platformFees)}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Top Fee Payers & Referral Earners */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Top Fee Payers */}
        <div className="rounded-lg border border-border bg-card p-6">
          <h3 className="mb-4 font-semibold text-lg">Top Fee Payers</h3>
          <div className="space-y-3">
            {stats.topFeePayers.map((user, index) => (
              <div
                key={user.userId}
                className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-accent/50"
              >
                <div className="w-6 font-bold text-muted-foreground text-sm">
                  #{index + 1}
                </div>
                <Avatar
                  src={user.profileImageUrl ?? undefined}
                  alt={user.displayName}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 truncate font-medium text-sm">
                    {user.displayName}
                    {user.isNPC && (
                      <span className="rounded bg-purple-500/20 px-1.5 py-0.5 text-purple-500 text-xs">
                        NPC
                      </span>
                    )}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {formatNumber(user.tradeCount)} trades
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-bold text-red-500 text-sm">
                    {formatCurrency(user.totalFees)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Top Referral Earners */}
        <div className="rounded-lg border border-border bg-card p-6">
          <h3 className="mb-4 font-semibold text-lg">Top Referral Earners</h3>
          <div className="space-y-3">
            {stats.topReferralEarners.length > 0 ? (
              stats.topReferralEarners.map((user, index) => (
                <div
                  key={user.userId}
                  className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-accent/50"
                >
                  <div className="w-6 font-bold text-muted-foreground text-sm">
                    #{index + 1}
                  </div>
                  <Avatar
                    src={user.profileImageUrl ?? undefined}
                    alt={user.displayName}
                    size="sm"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-sm">
                      {user.displayName}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {formatNumber(user.referralCount)} referral trades
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold text-green-500 text-sm">
                      {formatCurrency(user.totalEarned)}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="py-8 text-center text-muted-foreground">
                No referral earnings yet
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recent Fee Transactions */}
      <div className="rounded-lg border border-border bg-card p-6">
        <h3 className="mb-4 font-semibold text-lg">Recent Fee Transactions</h3>
        <div className="space-y-2">
          {stats.recentFees.map((fee) => (
            <div
              key={fee.id}
              className="flex items-center gap-3 rounded-lg p-3 transition-colors hover:bg-accent/50"
            >
              <Avatar
                src={fee.profileImageUrl ?? undefined}
                alt={fee.displayName}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-medium text-sm">
                  {fee.displayName}
                  {fee.isNPC && (
                    <span className="rounded bg-purple-500/20 px-1.5 py-0.5 text-purple-500 text-xs">
                      NPC
                    </span>
                  )}
                </div>
                <div className="text-muted-foreground text-xs">
                  {formatTradeType(fee.tradeType)} •{' '}
                  {new Date(fee.createdAt).toLocaleString()}
                </div>
              </div>
              <div className="text-right">
                <div className="font-bold text-red-500 text-sm">
                  {formatCurrency(fee.feeAmount)}
                </div>
                <div className="text-muted-foreground text-xs">
                  Platform: {formatCurrency(fee.platformFee)}
                  {fee.referrerFee > 0 &&
                    ` • Referrer: ${formatCurrency(fee.referrerFee)}`}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
