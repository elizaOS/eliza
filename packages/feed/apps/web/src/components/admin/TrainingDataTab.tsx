'use client';

import { FEED_POINTS_SYMBOL, cn } from '@feed/shared';
import {
  AlertCircle,
  CheckCircle,
  Database,
  RefreshCw,
  TrendingUp,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { getAuthToken } from '@/lib/auth';
import { apiUrl } from '@/utils/api-url';

/**
 * Training data statistics structure for training data tab.
 */
interface TrainingDataStats {
  summary: {
    totalTrajectories: number;
    totalWindows: number;
    readyWindows: number;
    minAgentsRequired: number;
  };
  windows: Array<{
    windowId: string;
    trajectoryCount: number;
    avgSteps: number;
    avgPnl: number;
  }>;
  readyWindows: Array<{
    windowId: string;
    trajectoryCount: number;
    avgSteps: number;
    avgPnl: number;
  }>;
  recentTrajectories: Array<{
    id: string;
    trajectoryId: string;
    agentId: string;
    windowId: string;
    episodeLength: number;
    finalPnL: number | null;
    tradesExecuted: number | null;
    createdAt: string;
  }>;
  qualityMetrics: {
    avgEpisodeLength: number;
    avgPnl: number;
    trainingDataQuality: string;
  };
}

/**
 * Training data tab component for monitoring training data statistics.
 *
 * Displays comprehensive training data statistics including trajectory counts,
 * window information, quality metrics, and recent trajectories. Shows data
 * quality assessment and readiness indicators.
 *
 * Features:
 * - Training data summary
 * - Window statistics
 * - Quality metrics display
 * - Recent trajectories list
 * - Quality color coding
 * - Loading states
 * - Error handling
 *
 * @returns Training data tab element
 */
export function TrainingDataTab() {
  const [data, setData] = useState<TrainingDataStats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const token = getAuthToken();
    if (!token) {
      setLoading(false);
      toast.error('Not authenticated');
      return;
    }

    const response = await fetch(apiUrl('/api/admin/training-data'), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      setLoading(false);
      toast.error('Failed to load training data');
      return;
    }

    const result = await response.json();
    setData(result.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-primary border-b-2" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        Failed to load training data statistics
      </div>
    );
  }

  const getQualityColor = (quality: string) => {
    switch (quality) {
      case 'good':
        return 'text-green-500';
      case 'fair':
        return 'text-yellow-500';
      case 'low':
        return 'text-red-500';
      default:
        return 'text-muted-foreground';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-bold text-2xl">Training Data Status</h2>
          <p className="mt-1 text-muted-foreground">
            Monitor collected trajectories and training readiness
          </p>
        </div>
        <button
          onClick={() => {
            setLoading(true);
            fetchData();
          }}
          disabled={loading}
          className="rounded-lg p-2 transition-colors hover:bg-accent"
        >
          <RefreshCw className={cn('h-5 w-5', loading && 'animate-spin')} />
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <div className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur">
          <div className="mb-2 flex items-center justify-between">
            <Database className="h-5 w-5 text-blue-500" />
            <span className="font-bold text-2xl">
              {data.summary.totalTrajectories}
            </span>
          </div>
          <div className="text-muted-foreground text-sm">
            Total Trajectories
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur">
          <div className="mb-2 flex items-center justify-between">
            <TrendingUp className="h-5 w-5 text-purple-500" />
            <span className="font-bold text-2xl">
              {data.summary.totalWindows}
            </span>
          </div>
          <div className="text-muted-foreground text-sm">Time Windows</div>
        </div>

        <div className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur">
          <div className="mb-2 flex items-center justify-between">
            <CheckCircle className="h-5 w-5 text-green-500" />
            <span className="font-bold text-2xl">
              {data.summary.readyWindows}
            </span>
          </div>
          <div className="text-muted-foreground text-sm">
            Ready for Training
          </div>
          <div className="mt-1 text-muted-foreground text-xs">
            (≥{data.summary.minAgentsRequired} agents)
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur">
          <div className="mb-2 flex items-center justify-between">
            <AlertCircle
              className={cn(
                'h-5 w-5',
                getQualityColor(data.qualityMetrics.trainingDataQuality)
              )}
            />
            <span
              className={cn(
                'font-bold text-2xl capitalize',
                getQualityColor(data.qualityMetrics.trainingDataQuality)
              )}
            >
              {data.qualityMetrics.trainingDataQuality}
            </span>
          </div>
          <div className="text-muted-foreground text-sm">Data Quality</div>
        </div>
      </div>

      {/* Quality Metrics */}
      <div className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur">
        <h3 className="mb-4 font-semibold text-lg">Quality Metrics</h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <div className="mb-1 text-muted-foreground text-sm">
              Avg Episode Length
            </div>
            <div className="font-mono text-2xl">
              {data.qualityMetrics.avgEpisodeLength.toFixed(1)} steps
            </div>
          </div>
          <div>
            <div className="mb-1 text-muted-foreground text-sm">Avg P&L</div>
            <div
              className={cn(
                'font-mono text-2xl',
                data.qualityMetrics.avgPnl >= 0
                  ? 'text-green-500'
                  : 'text-red-500'
              )}
            >
              {FEED_POINTS_SYMBOL}
              {data.qualityMetrics.avgPnl.toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      {/* Ready Windows */}
      {data.readyWindows.length > 0 && (
        <div className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur">
          <h3 className="mb-4 font-semibold text-lg">
            Ready for Training ({data.readyWindows.length})
          </h3>
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {data.readyWindows.slice(0, 10).map((window) => (
              <div
                key={window.windowId}
                className="rounded-lg border border-green-500/20 bg-green-500/10 p-3"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-mono text-sm">{window.windowId}</div>
                    <div className="mt-1 text-muted-foreground text-xs">
                      {window.trajectoryCount} agents •{' '}
                      {window.avgSteps.toFixed(0)} avg steps
                    </div>
                  </div>
                  <div className="text-right">
                    <div
                      className={cn(
                        'font-mono text-sm',
                        window.avgPnl >= 0 ? 'text-green-500' : 'text-red-500'
                      )}
                    >
                      {window.avgPnl >= 0 ? '+' : ''}
                      {FEED_POINTS_SYMBOL}
                      {window.avgPnl.toFixed(2)}
                    </div>
                    <div className="text-muted-foreground text-xs">avg P&L</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Trajectories */}
      <div className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur">
        <h3 className="mb-4 font-semibold text-lg">Recent Trajectories</h3>
        {data.recentTrajectories.length > 0 ? (
          <div className="max-h-96 space-y-2 overflow-y-auto">
            {data.recentTrajectories.map((traj) => (
              <div
                key={traj.id}
                className="rounded-lg border border-border bg-accent/50 p-3"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="font-mono text-muted-foreground text-xs">
                        {traj.windowId}
                      </span>
                      <span className="rounded bg-primary/20 px-2 py-0.5 text-primary text-xs">
                        {traj.episodeLength} steps
                      </span>
                    </div>
                    <div className="truncate font-mono text-sm">
                      {traj.trajectoryId.substring(0, 20)}...
                    </div>
                    <div className="mt-1 text-muted-foreground text-xs">
                      Agent: {traj.agentId.substring(0, 12)}... •
                      {traj.tradesExecuted
                        ? ` ${traj.tradesExecuted} trades`
                        : ' No trades'}
                    </div>
                  </div>
                  <div className="text-right">
                    {traj.finalPnL !== null && (
                      <div
                        className={cn(
                          'font-mono text-sm',
                          traj.finalPnL >= 0 ? 'text-green-500' : 'text-red-500'
                        )}
                      >
                        {traj.finalPnL >= 0 ? '+' : ''}
                        {FEED_POINTS_SYMBOL}
                        {traj.finalPnL.toFixed(2)}
                      </div>
                    )}
                    <div className="mt-1 text-muted-foreground text-xs">
                      {new Date(traj.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-8 text-center text-muted-foreground">
            No trajectories recorded yet
          </div>
        )}
      </div>

      {/* Status Messages */}
      {data.summary.totalTrajectories === 0 && (
        <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-6">
          <div className="flex gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-yellow-500" />
            <div className="text-sm">
              <p className="mb-2 font-medium text-yellow-200">
                No Training Data Collected Yet
              </p>
              <p className="text-yellow-200/80">
                Trajectory recording is always enabled. Run agents through
                benchmarks or wait for game ticks to collect training data.
              </p>
            </div>
          </div>
        </div>
      )}

      {data.summary.readyWindows === 0 &&
        data.summary.totalTrajectories > 0 && (
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-6">
            <div className="flex gap-3">
              <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-blue-500" />
              <div className="text-sm">
                <p className="mb-2 font-medium text-blue-200">
                  Not Ready for Training
                </p>
                <p className="text-blue-200/80">
                  Need at least {data.summary.minAgentsRequired} trajectories
                  per window for GRPO training. Current windows have fewer
                  agents. Run more benchmarks or wait for more game ticks.
                </p>
              </div>
            </div>
          </div>
        )}

      {data.summary.readyWindows > 0 && (
        <div className="rounded-lg border border-green-500/20 bg-green-500/10 p-6">
          <div className="flex gap-3">
            <CheckCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-500" />
            <div className="text-sm">
              <p className="mb-2 font-medium text-green-200">
                Ready for Training!
              </p>
              <p className="mb-3 text-green-200/80">
                {data.summary.readyWindows} window
                {data.summary.readyWindows > 1 ? 's' : ''} ready with sufficient
                data. You can now run RL training:
              </p>
              <code className="block rounded bg-black/30 p-3 font-mono text-green-100 text-xs">
                cd python{'\n'}
                MODE=single python -m src.training.feed_trainer
              </code>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
