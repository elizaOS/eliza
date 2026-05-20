'use client';

import { cn } from '@feed/shared';
import { Activity } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { PageContainer } from '@/components/shared/PageContainer';
import { apiUrl } from '@/utils/api-url';

interface GameStats {
  totalPosts: number;
  activeQuestions: number;
  totalCompanies: number;
}

interface EngineStatus {
  isRunning: boolean;
  currentDay?: number;
  currentDate?: string;
  speed?: number;
  lastTickAt?: string;
}

export default function GamePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<GameStats | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadGameData = useCallback(async () => {
    setRefreshing(true);
    const response = await fetch(apiUrl('/api/stats'));
    if (!response.ok) {
      setError('Failed to load game data');
      setLoading(false);
      setRefreshing(false);
      return;
    }
    const data = await response.json();
    setStats(data.stats);
    setEngineStatus(data.engineStatus);
    setError(null);
    setLoading(false);
    setRefreshing(false);
  }, []);

  // Initial load
  useEffect(() => {
    loadGameData();

    // Refresh every 10 seconds
    const interval = setInterval(loadGameData, 10000);
    return () => clearInterval(interval);
  }, [loadGameData]);

  if (loading) {
    return (
      <PageContainer className="flex items-center justify-center">
        <div className="text-lg text-muted-foreground">
          Loading game status...
        </div>
      </PageContainer>
    );
  }

  if (error) {
    return (
      <PageContainer className="flex flex-col items-center justify-center gap-4">
        <div className="text-destructive text-lg">⚠️ {error}</div>
        <p className="max-w-md text-center text-muted-foreground text-sm">
          The game tick may not be running. Start with:{' '}
          <code className="rounded bg-muted px-2 py-1">bun run dev</code>
        </p>
      </PageContainer>
    );
  }

  const currentDate = engineStatus?.currentDate
    ? new Date(engineStatus.currentDate)
    : new Date();
  const lastTick = engineStatus?.lastTickAt
    ? new Date(engineStatus.lastTickAt)
    : null;

  return (
    <PageContainer className="overflow-y-auto pb-24 md:pb-4">
      <div className="mx-auto max-w-feed space-y-4 px-4 pt-4">
        {/* Engine Status Card */}
        <div
          className={cn(
            'rounded-2xl border border-border bg-card p-6',
            'shadow-md'
          )}
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-bold text-lg">Continuous Game Engine</h2>
            <div className="flex items-center gap-2">
              <Activity
                className={cn(
                  'h-4 w-4',
                  engineStatus?.isRunning
                    ? 'animate-pulse text-green-500'
                    : 'text-muted-foreground'
                )}
              />
              <span
                className={cn(
                  'font-medium text-sm',
                  engineStatus?.isRunning
                    ? 'text-green-500'
                    : 'text-muted-foreground'
                )}
              >
                {engineStatus?.isRunning ? 'Running' : 'Stopped'}
              </span>
            </div>
          </div>

          {/* Current Game Time */}
          <div className="space-y-2">
            <div>
              <div className="mb-1 text-muted-foreground text-xs">
                Current Game Date
              </div>
              <div className="font-bold text-2xl" style={{ color: '#0066FF' }}>
                {currentDate.toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </div>
              <div className="mt-1 text-muted-foreground text-sm">
                Day {engineStatus?.currentDay || 1}
              </div>
            </div>

            {lastTick && (
              <div>
                <div className="mb-1 text-muted-foreground text-xs">
                  Last Tick
                </div>
                <div className="text-sm">
                  {lastTick.toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Game Stats Card */}
        <div
          className={cn(
            'rounded-2xl border border-border bg-card p-6',
            'shadow-md'
          )}
        >
          <h3 className="mb-4 font-semibold text-sm">Game Statistics</h3>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="mb-1 text-muted-foreground text-xs">
                Total Posts
              </div>
              <div className="font-bold text-2xl" style={{ color: '#0066FF' }}>
                {stats?.totalPosts?.toLocaleString() || '0'}
              </div>
            </div>
            <div>
              <div className="mb-1 text-muted-foreground text-xs">
                Active Questions
              </div>
              <div className="font-bold text-2xl" style={{ color: '#0066FF' }}>
                {stats?.activeQuestions || '0'}
              </div>
            </div>
            <div>
              <div className="mb-1 text-muted-foreground text-xs">
                Companies
              </div>
              <div className="font-bold text-2xl" style={{ color: '#0066FF' }}>
                {stats?.totalCompanies || '0'}
              </div>
            </div>
          </div>
        </div>

        {/* Refresh Button */}
        <div className="flex justify-center">
          <button
            onClick={loadGameData}
            disabled={refreshing}
            className={cn(
              'rounded-lg px-6 py-3 font-semibold',
              'bg-primary text-primary-foreground',
              'hover:bg-primary/90',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'transition-all duration-300'
            )}
          >
            {refreshing ? 'Refreshing...' : 'Refresh Stats'}
          </button>
        </div>

        {/* Info Card */}
        <div
          className={cn(
            'rounded-2xl border border-border bg-card p-6',
            'shadow-md'
          )}
        >
          <h3 className="mb-3 font-semibold text-sm">About Continuous Mode</h3>
          <div className="space-y-2 text-muted-foreground text-sm">
            <p>
              The continuous game engine runs in real-time, generating 10-20
              posts per minute and updating markets automatically.
            </p>
            <p>
              Posts appear in the{' '}
              <span className="font-medium text-foreground">Home</span> feed as
              they&apos;re generated. Prediction markets update in the{' '}
              <span className="font-medium text-foreground">Markets</span> tab.
            </p>
            <p className="mt-4 rounded-lg bg-muted p-3 text-xs">
              <span className="font-medium">Start development:</span>{' '}
              <code>bun run dev</code>
            </p>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
