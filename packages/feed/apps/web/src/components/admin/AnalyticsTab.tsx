/**
 * Analytics tab component for visualizing platform metrics over time.
 *
 * Displays time-series charts for user signups, content creation, and
 * engagement metrics. Supports different time periods (day, week, month)
 * and provides summary statistics with trend indicators.
 *
 * Features:
 * - User signups over time chart
 * - Posts and comments over time chart
 * - Reactions and follows over time chart
 * - Period selection (day, week, month)
 * - Summary statistics with totals
 * - Trend indicators
 * - Loading states
 * - Auto-refresh
 *
 * @returns Analytics tab element
 */
'use client';

import { cn } from '@babylon/shared';
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Heart,
  MessageSquare,
  RefreshCw,
  TrendingUp,
  UserPlus,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useState, useTransition } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Skeleton } from '@/components/shared/Skeleton';
import { apiUrl } from '@/utils/api-url';

type PeriodType = 'day' | 'week' | 'month';

interface TimeSeriesDataPoint {
  date: string;
  users: number;
  posts: number;
  comments: number;
  reactions: number;
  follows: number;
}

interface AnalyticsData {
  period: PeriodType;
  startDate: string;
  endDate: string;
  timeSeries: TimeSeriesDataPoint[];
  totals: {
    users: number;
    posts: number;
    comments: number;
    reactions: number;
    follows: number;
  };
}

export function AnalyticsTab() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<PeriodType>('week');
  const [isRefreshing, startRefresh] = useTransition();

  const fetchAnalytics = useCallback(
    (showRefreshing = false) => {
      const fetchLogic = async () => {
        const response = await fetch(
          apiUrl(`/api/admin/analytics?period=${period}`)
        );
        if (!response.ok) {
          setLoading(false);
          return;
        }
        const result = await response.json();
        setData(result);
        setLoading(false);
      };

      if (showRefreshing) {
        startRefresh(fetchLogic);
      } else {
        void fetchLogic();
      }
    },
    [period]
  );

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => fetchAnalytics(), 60000);
    return () => clearInterval(interval);
  }, [fetchAnalytics]);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    if (period === 'month') {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        year: '2-digit',
      });
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const formatNumber = (value: number) => {
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
    return value.toLocaleString();
  };

  // Calculate trends (compare last half to first half of period)
  const calculateTrend = (
    data: TimeSeriesDataPoint[],
    key: keyof TimeSeriesDataPoint
  ): { value: number; direction: 'up' | 'down' | 'neutral' } => {
    if (data.length < 2) return { value: 0, direction: 'neutral' };

    const midpoint = Math.floor(data.length / 2);
    const firstHalf = data.slice(0, midpoint);
    const secondHalf = data.slice(midpoint);

    const firstSum = firstHalf.reduce((sum, d) => sum + (d[key] as number), 0);
    const secondSum = secondHalf.reduce(
      (sum, d) => sum + (d[key] as number),
      0
    );

    if (firstSum === 0)
      return {
        value: secondSum > 0 ? 100 : 0,
        direction: secondSum > 0 ? 'up' : 'neutral',
      };

    const percentChange = ((secondSum - firstSum) / firstSum) * 100;
    return {
      value: Math.abs(percentChange),
      direction:
        percentChange > 5 ? 'up' : percentChange < -5 ? 'down' : 'neutral',
    };
  };

  // Static color classes for Tailwind JIT compatibility
  const colorClasses = {
    blue: { bg: 'bg-blue-500/10', text: 'text-blue-500' },
    purple: { bg: 'bg-purple-500/10', text: 'text-purple-500' },
    green: { bg: 'bg-green-500/10', text: 'text-green-500' },
    red: { bg: 'bg-red-500/10', text: 'text-red-500' },
    orange: { bg: 'bg-orange-500/10', text: 'text-orange-500' },
  } as const;

  type StatCardColor = keyof typeof colorClasses;

  const StatCard = ({
    icon: Icon,
    label,
    value,
    trend,
    color,
  }: {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    value: number;
    trend: { value: number; direction: 'up' | 'down' | 'neutral' };
    color: StatCardColor;
  }) => (
    <div className="rounded-xl border border-border bg-card p-5 transition-shadow hover:shadow-md">
      <div className="mb-3 flex items-center justify-between">
        <div className={cn('rounded-lg p-2', colorClasses[color].bg)}>
          <Icon className={cn('h-5 w-5', colorClasses[color].text)} />
        </div>
        {trend.direction !== 'neutral' && (
          <div
            className={cn(
              'flex items-center gap-1 rounded-full px-2 py-1 font-medium text-xs',
              trend.direction === 'up'
                ? 'bg-green-500/10 text-green-500'
                : 'bg-red-500/10 text-red-500'
            )}
          >
            {trend.direction === 'up' ? (
              <ArrowUp className="h-3 w-3" />
            ) : (
              <ArrowDown className="h-3 w-3" />
            )}
            {trend.value.toFixed(1)}%
          </div>
        )}
      </div>
      <div className="font-bold text-3xl">{formatNumber(value)}</div>
      <div className="mt-1 text-muted-foreground text-sm">{label}</div>
    </div>
  );

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-28 sm:h-32" />
          ))}
        </div>
        <Skeleton className="h-64 sm:h-80" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
          <Skeleton className="h-64 sm:h-72" />
          <Skeleton className="h-64 sm:h-72" />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <BarChart3 className="mx-auto mb-3 h-12 w-12 opacity-50" />
        <p>Failed to load analytics data</p>
      </div>
    );
  }

  const userTrend = calculateTrend(data.timeSeries, 'users');
  const postTrend = calculateTrend(data.timeSeries, 'posts');
  const commentTrend = calculateTrend(data.timeSeries, 'comments');
  const reactionTrend = calculateTrend(data.timeSeries, 'reactions');
  const followTrend = calculateTrend(data.timeSeries, 'follows');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 font-bold text-2xl">
            <BarChart3 className="h-6 w-6 text-blue-500" />
            Platform Analytics
          </h2>
          <p className="mt-1 text-muted-foreground">
            {new Date(data.startDate).toLocaleDateString()} -{' '}
            {new Date(data.endDate).toLocaleDateString()}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {/* Period Selector */}
          <div className="flex rounded-lg border border-border bg-card">
            {(['day', 'week', 'month'] as const).map((p) => (
              <button
                key={p}
                onClick={() => {
                  setPeriod(p);
                  setLoading(true);
                }}
                className={cn(
                  'px-2.5 py-1.5 font-medium text-xs transition-colors first:rounded-l-lg last:rounded-r-lg sm:px-4 sm:py-2 sm:text-sm',
                  period === p
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted'
                )}
              >
                {p === 'day' ? '7D' : p === 'week' ? '4W' : '6M'}
              </button>
            ))}
          </div>

          <button
            onClick={() => fetchAnalytics(true)}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 font-medium text-xs transition-colors hover:bg-muted/80 disabled:opacity-50 sm:gap-2 sm:px-3 sm:py-2 sm:text-sm"
          >
            <RefreshCw
              className={cn(
                'h-3.5 w-3.5 sm:h-4 sm:w-4',
                isRefreshing && 'animate-spin'
              )}
            />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          icon={UserPlus}
          label="New Users"
          value={data.totals.users}
          trend={userTrend}
          color="blue"
        />
        <StatCard
          icon={MessageSquare}
          label="Posts Created"
          value={data.totals.posts}
          trend={postTrend}
          color="purple"
        />
        <StatCard
          icon={MessageSquare}
          label="Comments"
          value={data.totals.comments}
          trend={commentTrend}
          color="green"
        />
        <StatCard
          icon={Heart}
          label="Reactions"
          value={data.totals.reactions}
          trend={reactionTrend}
          color="red"
        />
        <StatCard
          icon={Users}
          label="New Follows"
          value={data.totals.follows}
          trend={followTrend}
          color="orange"
        />
      </div>

      {/* User Growth Chart */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="mb-4 flex items-center gap-2 font-semibold text-lg">
          <TrendingUp className="h-5 w-5 text-blue-500" />
          User Growth
        </h3>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={data.timeSeries}>
            <defs>
              <linearGradient id="userGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis
              dataKey="date"
              stroke="#888"
              fontSize={12}
              tickFormatter={formatDate}
            />
            <YAxis stroke="#888" fontSize={12} />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1a1a1a',
                border: '1px solid #333',
                borderRadius: '8px',
              }}
              labelFormatter={(label) => formatDate(label)}
            />
            <Area
              type="monotone"
              dataKey="users"
              stroke="#3b82f6"
              strokeWidth={2}
              fill="url(#userGradient)"
              name="New Users"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Content & Engagement Charts */}
      <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-2">
        {/* Content Creation */}
        <div className="rounded-xl border border-border bg-card p-6">
          <h3 className="mb-4 flex items-center gap-2 font-semibold text-lg">
            <MessageSquare className="h-5 w-5 text-purple-500" />
            Content Creation
          </h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data.timeSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis
                dataKey="date"
                stroke="#888"
                fontSize={11}
                tickFormatter={formatDate}
              />
              <YAxis stroke="#888" fontSize={11} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1a1a1a',
                  border: '1px solid #333',
                  borderRadius: '8px',
                }}
                labelFormatter={(label) => formatDate(label)}
              />
              <Legend />
              <Bar
                dataKey="posts"
                name="Posts"
                fill="#a855f7"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="comments"
                name="Comments"
                fill="#22c55e"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Engagement */}
        <div className="rounded-xl border border-border bg-card p-6">
          <h3 className="mb-4 flex items-center gap-2 font-semibold text-lg">
            <Heart className="h-5 w-5 text-red-500" />
            Engagement
          </h3>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={data.timeSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis
                dataKey="date"
                stroke="#888"
                fontSize={11}
                tickFormatter={formatDate}
              />
              <YAxis stroke="#888" fontSize={11} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1a1a1a',
                  border: '1px solid #333',
                  borderRadius: '8px',
                }}
                labelFormatter={(label) => formatDate(label)}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="reactions"
                name="Reactions"
                stroke="#ef4444"
                strokeWidth={2}
                dot={{ fill: '#ef4444', r: 3 }}
              />
              <Line
                type="monotone"
                dataKey="follows"
                name="Follows"
                stroke="#f97316"
                strokeWidth={2}
                dot={{ fill: '#f97316', r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Daily Breakdown Table */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="mb-4 font-semibold text-lg">Daily Breakdown</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-border border-b text-muted-foreground">
              <tr>
                <th className="pb-3 font-medium">Date</th>
                <th className="pb-3 text-right font-medium">Users</th>
                <th className="pb-3 text-right font-medium">Posts</th>
                <th className="pb-3 text-right font-medium">Comments</th>
                <th className="pb-3 text-right font-medium">Reactions</th>
                <th className="pb-3 text-right font-medium">Follows</th>
              </tr>
            </thead>
            <tbody>
              {data.timeSeries
                .slice(-10)
                .reverse()
                .map((row) => (
                  <tr
                    key={row.date}
                    className="border-border/50 border-b last:border-0"
                  >
                    <td className="py-3 font-medium">{formatDate(row.date)}</td>
                    <td className="py-3 text-right font-mono text-blue-500">
                      {row.users}
                    </td>
                    <td className="py-3 text-right font-mono text-purple-500">
                      {row.posts}
                    </td>
                    <td className="py-3 text-right font-mono text-green-500">
                      {row.comments}
                    </td>
                    <td className="py-3 text-right font-mono text-red-500">
                      {row.reactions}
                    </td>
                    <td className="py-3 text-right font-mono text-orange-500">
                      {row.follows}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
