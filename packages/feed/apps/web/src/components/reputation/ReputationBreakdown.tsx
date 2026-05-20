/**
 * Reputation breakdown component for displaying detailed reputation score components.
 *
 * Displays a detailed breakdown of how PnL, Feedback, and Activity contribute
 * to the overall reputation score. Shows component values, weights, and metrics
 * with visual progress bars and color-coded indicators.
 *
 * Features:
 * - Component breakdown (PnL, Feedback, Activity)
 * - Weight display
 * - Progress bars
 * - Metric display
 * - Color-coded components
 * - Loading states
 * - Empty state handling
 *
 * @param props - ReputationBreakdown component props
 * @returns Reputation breakdown element
 *
 * @example
 * ```tsx
 * <ReputationBreakdown
 *   userId="user-123"
 * />
 * ```
 */
'use client';

import { cn } from '@feed/shared';
import { Activity, DollarSign, MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiUrl } from '@/utils/api-url';

/**
 * Breakdown data structure from API.
 */
interface BreakdownData {
  userId: string;
  reputationScore: number;
  trustLevel: string;
  confidenceScore: number;
  breakdown: {
    pnlComponent: number;
    feedbackComponent: number;
    activityComponent: number;
  };
  metrics: {
    normalizedPnL: number;
    averageFeedbackScore: number;
    gamesPlayed: number;
    totalFeedbackCount: number;
    winRate: number;
  };
  weights: {
    pnl: number;
    feedback: number;
    activity: number;
  };
}

interface ReputationBreakdownProps {
  userId: string;
  className?: string;
}

export function ReputationBreakdown({
  userId,
  className = '',
}: ReputationBreakdownProps) {
  const [breakdown, setBreakdown] = useState<BreakdownData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchBreakdown = async () => {
      setLoading(true);
      const response = await fetch(
        apiUrl(`/api/reputation/breakdown/${encodeURIComponent(userId)}`)
      );
      const data = await response.json();

      if (data.success) {
        setBreakdown(data);
      }
      setLoading(false);
    };

    fetchBreakdown();
  }, [userId]);

  if (loading) {
    return (
      <div className={cn('rounded-lg bg-sidebar p-4', className)}>
        <div className="text-muted-foreground text-sm">
          Loading breakdown...
        </div>
      </div>
    );
  }

  if (!breakdown) {
    return (
      <div className={cn('rounded-lg bg-sidebar p-4', className)}>
        <div className="text-muted-foreground text-sm">
          Breakdown data unavailable
        </div>
      </div>
    );
  }

  const components = [
    {
      name: 'PNL Performance',
      value: breakdown.breakdown.pnlComponent,
      weight: breakdown.weights.pnl * 100,
      icon: DollarSign,
      color: 'text-green-500',
      bgColor: 'bg-green-500/10',
      metric: `${breakdown.metrics.normalizedPnL.toFixed(2)} normalized PNL`,
    },
    {
      name: 'Feedback Score',
      value: breakdown.breakdown.feedbackComponent,
      weight: breakdown.weights.feedback * 100,
      icon: MessageSquare,
      color: 'text-blue-500',
      bgColor: 'bg-blue-500/10',
      metric: `${breakdown.metrics.averageFeedbackScore.toFixed(0)}/100 avg (${breakdown.metrics.totalFeedbackCount} reviews)`,
    },
    {
      name: 'Activity Level',
      value: breakdown.breakdown.activityComponent,
      weight: breakdown.weights.activity * 100,
      icon: Activity,
      color: 'text-purple-500',
      bgColor: 'bg-purple-500/10',
      metric: `${breakdown.metrics.gamesPlayed} games played`,
    },
  ];

  return (
    <div className={cn('space-y-4 rounded-lg bg-sidebar p-4', className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-foreground text-lg">
          Reputation Breakdown
        </h3>
        <div className="text-muted-foreground text-sm">
          Confidence: {(breakdown.confidenceScore * 100).toFixed(0)}%
        </div>
      </div>

      {/* Total Score */}
      <div className="rounded-lg bg-muted/30 p-4 text-center">
        <div className="mb-1 text-muted-foreground text-xs">
          Total Reputation
        </div>
        <div className="font-bold text-3xl text-foreground">
          {Math.round(breakdown.reputationScore)}
        </div>
        <div className="mt-1 text-muted-foreground text-xs capitalize">
          {breakdown.trustLevel}
        </div>
      </div>

      {/* Components Breakdown */}
      <div className="space-y-3">
        {components.map((component) => {
          const Icon = component.icon;
          return (
            <div key={component.name} className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={cn('rounded p-1.5', component.bgColor)}>
                    <Icon className={cn('h-4 w-4', component.color)} />
                  </div>
                  <div>
                    <div className="font-medium text-foreground text-sm">
                      {component.name}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {component.metric}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-bold text-foreground text-sm">
                    {component.value.toFixed(1)}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {component.weight}% weight
                  </div>
                </div>
              </div>

              {/* Progress Bar */}
              <div className="h-2 w-full rounded-full bg-muted/30">
                <div
                  className={cn('h-2 rounded-full', component.bgColor)}
                  style={{ width: `${Math.min(100, component.value)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Calculation Note */}
      <div className="border-border border-t pt-3 text-muted-foreground text-xs italic">
        Reputation = (PNL × 40%) + (Feedback × 40%) + (Activity × 20%)
      </div>
    </div>
  );
}
