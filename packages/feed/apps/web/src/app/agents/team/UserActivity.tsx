'use client';

import {
  BABYLON_POINTS_SYMBOL,
  cn,
  formatCompactCurrency,
  getTimeAgo,
  logger,
} from '@babylon/shared';
import { Activity } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { apiUrl } from '@/utils/api-url';

/** Activity types from the API */
interface TradeActivity {
  type: 'trade';
  id: string;
  timestamp: string;
  data: {
    tradeType: string; // pred_buy, pred_sell, perp_open, perp_close
    marketId: string | null;
    marketQuestion: string | null;
    amount: number;
    description: string | null;
  };
}

interface PointsActivity {
  type: 'points';
  id: string;
  timestamp: string;
  data: {
    amount: number;
    pointsBefore: number;
    pointsAfter: number;
    reason: string;
    paymentProvider: string | null;
  };
}

interface PostActivity {
  type: 'post';
  id: string;
  timestamp: string;
  data: {
    postId: string;
    contentPreview: string;
  };
}

interface CommentActivity {
  type: 'comment';
  id: string;
  timestamp: string;
  data: {
    commentId: string;
    postId: string;
    contentPreview: string;
    parentCommentId: string | null;
  };
}

type UserActivityItem =
  | TradeActivity
  | PointsActivity
  | PostActivity
  | CommentActivity;

interface UserActivityProps {
  userId: string;
  className?: string;
}

/**
 * Get human-readable reason label for points transactions
 */
function getReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    purchase: 'Added trading funds',
    purchase_refund: 'Received refund',
    purchase_dispute: 'Funding dispute deduction',
    purchase_dispute_won: 'Funding dispute won',
    trading_pnl: 'Trading P&L',
    transfer_sent: 'Balance transfer out',
    transfer_received: 'Balance transfer in',
    referral_signup: 'Referral bonus',
    referral_qualified: 'Qualified referral bonus',
    profile_completion: 'Profile completion bonus',
    farcaster_link: 'Linked Farcaster',
    twitter_link: 'Linked Twitter',
    discord_link: 'Linked Discord',
    wallet_connect: 'Connected wallet',
    admin_award: 'Admin award',
    admin_deduction: 'Admin deduction',
    report_reward: 'Report reward',
    agent_deposit: 'Deposited to agent',
    agent_withdrawal: 'Withdrew from agent',
  };
  return (
    labels[reason] ||
    reason.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/**
 * Get trade title based on trade type
 */
function getTradeTitle(tradeType: string): string {
  const titles: Record<string, string> = {
    pred_buy: 'Bought prediction position',
    pred_sell: 'Sold prediction position',
    perp_open: 'Opened perp position',
    perp_close: 'Closed perp position',
    perp_liquidation: 'Position liquidated',
  };
  return titles[tradeType] || 'Trade';
}

/**
 * Get activity title
 */
function getActivityTitle(activity: UserActivityItem): string {
  if (activity.type === 'trade') {
    return getTradeTitle(activity.data.tradeType);
  }
  if (activity.type === 'points') {
    return getReasonLabel(activity.data.reason);
  }
  if (activity.type === 'post') {
    return 'Created a post';
  }
  if (activity.type === 'comment') {
    return activity.data.parentCommentId
      ? 'Replied to a comment'
      : 'Commented on a post';
  }
  return 'Activity';
}

/**
 * Amount badge component for points
 */
function AmountBadge({ amount }: { amount: number }) {
  const isPositive = amount >= 0;
  return (
    <div
      className={cn(
        'shrink-0 rounded-md px-2.5 py-1 font-medium font-mono text-sm',
        isPositive
          ? 'border border-emerald-300 bg-emerald-100 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400'
          : 'border border-red-300 bg-red-100 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-400'
      )}
    >
      {isPositive ? '+' : ''}
      {formatCompactCurrency(amount)}
    </div>
  );
}

/**
 * Activity card component (matches AgentActivityCard style)
 */
const ActivityCard = memo(function ActivityCard({
  activity,
}: {
  activity: UserActivityItem;
}) {
  const [expanded, setExpanded] = useState(false);
  const timestamp = new Date(activity.timestamp);
  const timeAgo = getTimeAgo(timestamp);
  const title = getActivityTitle(activity);
  const content = renderActivityContent(activity, expanded);

  // Determine which badge to show
  let badge = null;
  if (activity.type === 'points') {
    badge = <AmountBadge amount={activity.data.amount} />;
  }

  return (
    <div
      className={cn(
        'group relative cursor-pointer rounded-lg border border-border p-4 transition-colors hover:border-border/80',
        'bg-card/50 hover:bg-card/80'
      )}
      onClick={() => setExpanded((prev) => !prev)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setExpanded((prev) => !prev);
        }
      }}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={`${title}. Click to ${expanded ? 'collapse' : 'expand'} details.`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {/* Header Row */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground text-sm">{title}</span>
            <span className="text-muted-foreground text-xs">{timeAgo}</span>
          </div>

          {/* Activity-specific content */}
          {content && <div className="mt-2">{content}</div>}
        </div>

        {/* Badge */}
        {badge}
      </div>
    </div>
  );
});

/**
 * Get subtitle for points activity (matches agent trade subtitle style)
 */
function getPointsSubtitle(
  reason: string,
  paymentProvider: string | null
): string | null {
  // Show payment provider for purchases
  if (reason === 'purchase' && paymentProvider) {
    return `via ${paymentProvider}`;
  }
  // Show context for other transaction types
  if (reason.includes('transfer')) {
    return 'Agent funding';
  }
  if (reason.includes('referral')) {
    return 'Referral program';
  }
  if (
    reason.includes('link') ||
    reason.includes('connect') ||
    reason.includes('profile')
  ) {
    return 'Onboarding reward';
  }
  if (reason === 'trading_pnl') {
    return 'Position settlement';
  }
  return null;
}

/**
 * Render activity-specific content
 */
function renderActivityContent(activity: UserActivityItem, expanded: boolean) {
  if (activity.type === 'trade') {
    const { tradeType, amount, marketQuestion } = activity.data;
    const isPrediction = tradeType.startsWith('pred_');
    const typeLabel = isPrediction ? 'Prediction' : 'Perpetual';

    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{typeLabel}</span>
          <span className="text-muted-foreground/60">•</span>
          <span className="font-mono text-foreground">
            {BABYLON_POINTS_SYMBOL}
            {amount.toLocaleString()}
          </span>
        </div>

        {marketQuestion && (
          <p
            className={cn(
              'text-muted-foreground text-sm',
              expanded ? '' : 'line-clamp-2'
            )}
          >
            {marketQuestion}
          </p>
        )}
      </div>
    );
  }

  if (activity.type === 'points') {
    const { reason, paymentProvider } = activity.data;
    const subtitle = getPointsSubtitle(reason, paymentProvider);

    // Only show subtitle if we have one (matching agent trade style)
    if (!subtitle) return null;

    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{subtitle}</span>
      </div>
    );
  }

  if (activity.type === 'post') {
    return (
      <p
        className={cn(
          'text-muted-foreground text-sm',
          expanded ? '' : 'line-clamp-2'
        )}
      >
        {activity.data.contentPreview}
      </p>
    );
  }

  if (activity.type === 'comment') {
    return (
      <p
        className={cn(
          'text-muted-foreground text-sm',
          expanded ? '' : 'line-clamp-2'
        )}
      >
        {activity.data.contentPreview}
      </p>
    );
  }

  return null;
}

/**
 * Loading skeleton (matches AgentActivityFeed exactly)
 */
function ActivitySkeleton() {
  return (
    <div className="animate-pulse rounded-lg border border-border p-4">
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 shrink-0 rounded-full bg-muted" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-48 rounded bg-muted" />
          <div className="h-3 w-32 rounded bg-muted" />
        </div>
      </div>
    </div>
  );
}

/**
 * Empty state (matches AgentActivityFeed exactly)
 */
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Activity className="mb-4 h-12 w-12 text-muted-foreground opacity-50" />
      <p className="font-semibold text-lg">No activity yet</p>
      <p className="mt-1 max-w-sm text-muted-foreground text-sm">
        Your trades, rewards, and posts will appear here
      </p>
    </div>
  );
}

/**
 * User Activity component - displays user's activity feed
 * (matches AgentActivityFeed structure exactly)
 */
export function UserActivity({ userId, className }: UserActivityProps) {
  const { getAccessToken } = useAuth();
  const [activities, setActivities] = useState<UserActivityItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      setError(new Error('Not authenticated'));
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(
        apiUrl(`/api/users/${userId}/activity?limit=50`),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const errorMessage =
          errorData.error || errorData.message || `Server error: ${res.status}`;
        throw new Error(errorMessage);
      }

      const data = await res.json();
      setActivities(data.activities || []);
    } catch (err) {
      logger.error(
        'Activity fetch error',
        err instanceof Error ? err : { error: err },
        'UserActivity'
      );
      setError(
        err instanceof Error ? err : new Error('Failed to load activity')
      );
    } finally {
      setIsLoading(false);
    }
  }, [userId, getAccessToken]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className={cn('flex flex-col', className)}>
      {/* Error state with retry button */}
      {error && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-destructive text-sm">
            Failed to load activity: {error.message}
          </p>
          <button
            onClick={() => void refresh()}
            disabled={isLoading}
            className="ml-3 shrink-0 rounded-md bg-destructive/20 px-3 py-1 text-destructive text-sm transition-colors hover:bg-destructive/30 disabled:opacity-50"
          >
            {isLoading ? 'Retrying...' : 'Retry'}
          </button>
        </div>
      )}

      {/* Loading skeleton */}
      {isLoading && activities.length === 0 && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <ActivitySkeleton key={i} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && activities.length === 0 && !error && <EmptyState />}

      {/* Activity list */}
      {activities.length > 0 && (
        <div className="space-y-3">
          {activities.map((activity) => (
            <ActivityCard key={activity.id} activity={activity} />
          ))}
        </div>
      )}
    </div>
  );
}
