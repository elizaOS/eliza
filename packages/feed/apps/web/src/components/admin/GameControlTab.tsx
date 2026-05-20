'use client';

import { cn } from '@babylon/shared';
import {
  Activity,
  Clock,
  Cpu,
  Database,
  FileText,
  MessageSquare,
  Pause,
  Play,
  RefreshCw,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Skeleton } from '@/components/shared/Skeleton';
import { apiUrl } from '@/utils/api-url';
import { WorldFactsSection } from './WorldFactsSection';

/**
 * Game state structure for game control tab.
 */
interface GameState {
  id: string;
  isRunning: boolean;
  currentDay: number;
  currentDate: string;
  startedAt: string | null;
  pausedAt: string | null;
  lastTickAt: string | null;
  timeSinceLastTickMs: number | null;
  tickIntervalMs: number;
  uptimeMs: number;
  uptimeMinutes: number;
  uptimeHours: number;
  estimatedTotalTicks: number;
}

/**
 * Game statistics structure for game control tab.
 */
interface GameStats {
  gameState: GameState;
  totals: {
    posts: number;
    articles: number;
    groupChats: number;
    chatMessages: number;
    llmCalls: number;
    avgMessagesPerChat: number;
  };
  last24Hours: {
    posts: number;
    articles: number;
    groupChats: number;
    messages: number;
    llmCalls: number;
  };
  lastHour: {
    posts: number;
    articles: number;
    groupChats: number;
    messages: number;
    llmCalls: number;
  };
  last5Minutes: {
    posts: number;
    articles: number;
    messages: number;
    llmCalls: number;
  };
  lastMinute: {
    posts: number;
    articles: number;
    messages: number;
    llmCalls: number;
  };
  rates: {
    postsPerMinute: number;
    articlesPerMinute: number;
    messagesPerMinute: number;
    llmCallsPerMinute: number;
    postsPerMinuteAvgHour: number;
    articlesPerMinuteAvgHour: number;
    messagesPerMinuteAvgHour: number;
    llmCallsPerMinuteAvgHour: number;
    postsPerMinuteAvgDay: number;
    articlesPerMinuteAvgDay: number;
    messagesPerMinuteAvgDay: number;
    llmCallsPerMinuteAvgDay: number;
  };
  llmStats: {
    totalCalls24h: number;
    totalPromptTokens24h: number;
    totalCompletionTokens24h: number;
    totalTokens24h: number;
    avgLatencyMs24h: number | null;
  };
}

/**
 * Game control tab component for managing game state and monitoring statistics.
 *
 * Provides interface for controlling game playback (start/pause), viewing
 * game state, and monitoring comprehensive statistics including content
 * generation rates, LLM usage, and system performance. Includes world facts
 * management section.
 *
 * Features:
 * - Game state display
 * - Start/pause controls
 * - Statistics dashboard
 * - Content generation rates
 * - LLM usage metrics
 * - World facts management
 * - Auto-refresh
 * - Loading states
 * - Error handling
 *
 * @returns Game control tab element
 */
export function GameControlTab() {
  const [stats, setStats] = useState<GameStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchStats = useCallback(async () => {
    const response = await fetch(apiUrl('/api/admin/game-stats'));
    if (!response.ok) {
      setLoading(false);
      setError('Failed to load stats');
      return;
    }
    const data = await response.json();
    setStats(data);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(fetchStats, 5000); // Refresh every 5 seconds
    return () => clearInterval(interval);
  }, [autoRefresh, fetchStats]);

  const handleGameControl = async (action: 'start' | 'pause') => {
    setActionLoading(true);
    const response = await fetch(apiUrl('/api/game/control'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });

    if (!response.ok) {
      setActionLoading(false);
      setError(`Failed to ${action} game`);
      return;
    }

    // Refresh stats immediately
    await fetchStats();
    setActionLoading(false);
  };

  const formatUptime = (minutes: number) => {
    if (minutes < 1) return '< 1 min';
    if (minutes < 60) return `${Math.round(minutes)} min`;
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    if (hours < 24) return `${hours}h ${mins}m`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h`;
  };

  const formatNumber = (value: number) => {
    if (value >= 1000000) return `${(value / 1000000).toFixed(2)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(2)}K`;
    return value.toLocaleString();
  };

  const StatCard = ({
    icon: Icon,
    label,
    value,
    subValue,
    color = 'blue',
    trend,
  }: {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    value: string | number;
    subValue?: string;
    color?: 'blue' | 'green' | 'purple' | 'orange' | 'red' | 'yellow';
    trend?: 'up' | 'down' | 'neutral';
  }) => {
    const colorClasses = {
      blue: 'text-blue-500 bg-blue-500/10',
      green: 'text-green-500 bg-green-500/10',
      purple: 'text-purple-500 bg-purple-500/10',
      orange: 'text-orange-500 bg-orange-500/10',
      red: 'text-red-500 bg-red-500/10',
      yellow: 'text-yellow-500 bg-yellow-500/10',
    };

    return (
      <div className="rounded-lg border border-border bg-card p-4 transition-shadow hover:shadow-md">
        <div className="mb-2 flex items-start justify-between">
          <div
            className={cn('rounded-lg p-2', colorClasses[color].split(' ')[1])}
          >
            <Icon
              className={cn('h-5 w-5', colorClasses[color].split(' ')[0])}
            />
          </div>
          {trend && (
            <TrendingUp
              className={cn(
                'h-4 w-4',
                trend === 'up'
                  ? 'text-green-500'
                  : trend === 'down'
                    ? 'text-red-500'
                    : 'text-gray-400'
              )}
            />
          )}
        </div>
        <div className="mb-1 font-bold text-2xl">{value}</div>
        <div className="text-muted-foreground text-sm">{label}</div>
        {subValue && (
          <div className="mt-1 text-muted-foreground text-xs">{subValue}</div>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="p-8 text-center text-red-500">
        {error || 'Failed to load game statistics'}
      </div>
    );
  }

  const { gameState, totals, rates, llmStats, lastMinute } = stats;

  return (
    <div className="space-y-6">
      {/* Game Control Header */}
      <div className="rounded-lg border border-border bg-gradient-to-br from-card to-accent/20 p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="font-bold text-2xl">Game Simulation Control</h2>
            <p className="text-muted-foreground">
              Manage autonomous game simulation and monitor real-time statistics
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={cn(
                'rounded-lg px-3 py-2 text-sm transition-colors',
                autoRefresh
                  ? 'bg-green-500/20 text-green-500'
                  : 'bg-gray-500/20 text-gray-500'
              )}
            >
              <RefreshCw
                className={cn('h-4 w-4', autoRefresh && 'animate-spin')}
              />
            </button>
            <button
              onClick={() => fetchStats()}
              disabled={actionLoading}
              className="rounded-lg bg-blue-500/20 px-4 py-2 text-blue-500 transition-colors hover:bg-blue-500/30 disabled:opacity-50"
            >
              Refresh Now
            </button>
          </div>
        </div>

        {/* Control Buttons */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <button
            onClick={() => handleGameControl('start')}
            disabled={actionLoading || gameState.isRunning}
            className={cn(
              'flex items-center justify-center gap-3 rounded-lg px-6 py-4 font-semibold transition-all',
              gameState.isRunning
                ? 'cursor-default border-2 border-green-500/50 bg-green-500/20 text-green-500'
                : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50'
            )}
          >
            {gameState.isRunning ? (
              <>
                <Activity className="h-5 w-5 animate-pulse" />
                Game Running
              </>
            ) : (
              <>
                <Play className="h-5 w-5" />
                Start Game
              </>
            )}
          </button>

          <button
            onClick={() => handleGameControl('pause')}
            disabled={actionLoading || !gameState.isRunning}
            className={cn(
              'flex items-center justify-center gap-3 rounded-lg px-6 py-4 font-semibold transition-all',
              !gameState.isRunning
                ? 'cursor-default border-2 border-gray-500/50 bg-gray-500/20 text-gray-500'
                : 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-50'
            )}
          >
            <Pause className="h-5 w-5" />
            {!gameState.isRunning ? 'Game Paused' : 'Pause Game'}
          </button>
        </div>

        {/* Game State Info */}
        <div className="mt-4 grid grid-cols-2 gap-4 border-border border-t pt-4 md:grid-cols-4">
          <div>
            <div className="mb-1 text-muted-foreground text-xs">Uptime</div>
            <div className="font-semibold">
              {formatUptime(gameState.uptimeMinutes)}
            </div>
          </div>
          <div>
            <div className="mb-1 text-muted-foreground text-xs">Game Day</div>
            <div className="font-semibold">Day {gameState.currentDay}</div>
          </div>
          <div>
            <div className="mb-1 text-muted-foreground text-xs">
              Total Ticks
            </div>
            <div className="font-semibold">
              {formatNumber(gameState.estimatedTotalTicks)}
            </div>
          </div>
          <div>
            <div className="mb-1 text-muted-foreground text-xs">Last Tick</div>
            <div className="font-semibold">
              {gameState.timeSinceLastTickMs !== null
                ? `${Math.round(gameState.timeSinceLastTickMs / 1000)}s ago`
                : 'Never'}
            </div>
          </div>
        </div>
      </div>

      {/* Real-time Activity (Last Minute) */}
      <div>
        <h3 className="mb-3 flex items-center gap-2 font-semibold text-lg text-muted-foreground uppercase tracking-wide">
          <Zap className="h-5 w-5 text-yellow-500" />
          Live Activity (Last Minute)
        </h3>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard
            icon={FileText}
            label="Posts Created"
            value={lastMinute.posts}
            subValue={`${rates.postsPerMinute}/min`}
            color="blue"
          />
          <StatCard
            icon={FileText}
            label="Articles Published"
            value={lastMinute.articles}
            subValue={`${rates.articlesPerMinute}/min`}
            color="purple"
          />
          <StatCard
            icon={MessageSquare}
            label="Messages Sent"
            value={lastMinute.messages}
            subValue={`${rates.messagesPerMinute}/min`}
            color="green"
          />
          <StatCard
            icon={Cpu}
            label="LLM Calls"
            value={lastMinute.llmCalls}
            subValue={`${rates.llmCallsPerMinute}/min`}
            color="orange"
          />
        </div>
      </div>

      {/* Total Statistics */}
      <div>
        <h3 className="mb-3 flex items-center gap-2 font-semibold text-lg text-muted-foreground uppercase tracking-wide">
          <Database className="h-5 w-5 text-blue-500" />
          Cumulative Statistics
        </h3>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          <StatCard
            icon={FileText}
            label="Total Posts"
            value={formatNumber(totals.posts)}
            color="blue"
          />
          <StatCard
            icon={FileText}
            label="Total Articles"
            value={formatNumber(totals.articles)}
            color="purple"
          />
          <StatCard
            icon={Users}
            label="Group Chats"
            value={formatNumber(totals.groupChats)}
            color="green"
          />
          <StatCard
            icon={MessageSquare}
            label="Chat Messages"
            value={formatNumber(totals.chatMessages)}
            color="green"
          />
          <StatCard
            icon={Activity}
            label="Avg Msgs/Chat"
            value={totals.avgMessagesPerChat.toFixed(1)}
            color="yellow"
          />
          <StatCard
            icon={Cpu}
            label="Total LLM Calls"
            value={formatNumber(totals.llmCalls)}
            color="orange"
          />
        </div>
      </div>

      {/* Average Rates */}
      <div>
        <h3 className="mb-3 flex items-center gap-2 font-semibold text-lg text-muted-foreground uppercase tracking-wide">
          <Clock className="h-5 w-5 text-green-500" />
          Average Rates (Per Minute)
        </h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <FileText className="h-4 w-4 text-blue-500" />
              <h4 className="font-semibold">Posts</h4>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Instant</span>
                <span className="font-semibold">
                  {rates.postsPerMinute}/min
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Hour Avg</span>
                <span className="font-semibold">
                  {rates.postsPerMinuteAvgHour.toFixed(2)}/min
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Day Avg</span>
                <span className="font-semibold">
                  {rates.postsPerMinuteAvgDay.toFixed(2)}/min
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <FileText className="h-4 w-4 text-purple-500" />
              <h4 className="font-semibold">Articles</h4>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Instant</span>
                <span className="font-semibold">
                  {rates.articlesPerMinute}/min
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Hour Avg</span>
                <span className="font-semibold">
                  {rates.articlesPerMinuteAvgHour.toFixed(2)}/min
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Day Avg</span>
                <span className="font-semibold">
                  {rates.articlesPerMinuteAvgDay.toFixed(2)}/min
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-green-500" />
              <h4 className="font-semibold">Messages</h4>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Instant</span>
                <span className="font-semibold">
                  {rates.messagesPerMinute}/min
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Hour Avg</span>
                <span className="font-semibold">
                  {rates.messagesPerMinuteAvgHour.toFixed(2)}/min
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Day Avg</span>
                <span className="font-semibold">
                  {rates.messagesPerMinuteAvgDay.toFixed(2)}/min
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <Cpu className="h-4 w-4 text-orange-500" />
              <h4 className="font-semibold">LLM Calls</h4>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Instant</span>
                <span className="font-semibold">
                  {rates.llmCallsPerMinute}/min
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Hour Avg</span>
                <span className="font-semibold">
                  {rates.llmCallsPerMinuteAvgHour.toFixed(2)}/min
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Day Avg</span>
                <span className="font-semibold">
                  {rates.llmCallsPerMinuteAvgDay.toFixed(2)}/min
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* LLM Usage Statistics (Last 24h) */}
      <div>
        <h3 className="mb-3 flex items-center gap-2 font-semibold text-lg text-muted-foreground uppercase tracking-wide">
          <Cpu className="h-5 w-5 text-orange-500" />
          LLM Usage (Last 24 Hours)
        </h3>
        <div className="rounded-lg border border-orange-500/20 bg-gradient-to-br from-orange-500/10 to-red-500/10 p-6">
          <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
            <div>
              <div className="mb-1 text-muted-foreground text-sm">
                Total Calls
              </div>
              <div className="font-bold text-2xl">
                {formatNumber(llmStats.totalCalls24h)}
              </div>
            </div>
            <div>
              <div className="mb-1 text-muted-foreground text-sm">
                Prompt Tokens
              </div>
              <div className="font-bold text-2xl">
                {formatNumber(llmStats.totalPromptTokens24h)}
              </div>
            </div>
            <div>
              <div className="mb-1 text-muted-foreground text-sm">
                Completion Tokens
              </div>
              <div className="font-bold text-2xl">
                {formatNumber(llmStats.totalCompletionTokens24h)}
              </div>
            </div>
            <div>
              <div className="mb-1 text-muted-foreground text-sm">
                Avg Latency
              </div>
              <div className="font-bold text-2xl">
                {llmStats.avgLatencyMs24h !== null
                  ? `${llmStats.avgLatencyMs24h}ms`
                  : 'N/A'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* World Facts Section */}
      <WorldFactsSection />
    </div>
  );
}
