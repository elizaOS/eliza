"use client";

import { cn } from "@polyagent/shared";
import {
  ArrowDownRight,
  ArrowUpRight,
  MessageCircle,
  MessageSquare,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { memo, useState } from "react";
import {
  type AgentActivity,
  isCommentActivity,
  isMessageActivity,
  isPostActivity,
  isTradeActivity,
} from "@/hooks/useAgentActivity";

interface AgentActivityCardProps {
  activity: AgentActivity;
  showAgent?: boolean;
  className?: string;
}

/**
 * Card component for displaying a single agent activity item.
 *
 * Renders different layouts based on activity type (trade, post, comment, message).
 * Shows relevant details like market, amount, P&L for trades, or content preview
 * for posts and comments.
 */
export const AgentActivityCard = memo(function AgentActivityCard({
  activity,
  showAgent = false,
  className,
}: AgentActivityCardProps) {
  const [expanded, setExpanded] = useState(false);

  const timestamp = new Date(activity.timestamp);
  const timeAgo = getTimeAgo(timestamp);

  return (
    <div
      className={cn(
        "group relative cursor-pointer rounded-lg border border-border p-4 transition-colors hover:border-border/80",
        "bg-card/50 hover:bg-card/80",
        className,
      )}
      onClick={() => setExpanded((prev) => !prev)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setExpanded((prev) => !prev);
        }
      }}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={`${getActivityTitle(activity)}. Click to ${expanded ? "collapse" : "expand"} details.`}
    >
      <div className="flex items-start gap-3">
        {/* Activity Icon */}
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
            getActivityIconBackground(activity),
          )}
        >
          {getActivityIcon(activity)}
        </div>

        <div className="min-w-0 flex-1">
          {/* Header Row */}
          <div className="flex flex-wrap items-center gap-2">
            {showAgent && activity.agent && (
              <span className="font-medium text-foreground text-sm">
                {activity.agent.name}
              </span>
            )}
            <span className="font-medium text-foreground text-sm">
              {getActivityTitle(activity)}
            </span>
            <span className="text-muted-foreground text-xs">{timeAgo}</span>
          </div>

          {/* Activity-specific content */}
          <div className="mt-2">
            {renderActivityContent(activity, expanded)}
          </div>
        </div>

        {/* P&L Badge for trades */}
        {activity.type === "trade" &&
          "pnl" in activity.data &&
          activity.data.pnl !== null && <PnLBadge pnl={activity.data.pnl} />}
      </div>
    </div>
  );
});

// Helper: Get activity icon
function getActivityIcon(activity: AgentActivity) {
  if (isTradeActivity(activity)) {
    const { side, action } = activity.data;
    const isLong = side === "long" || side === "yes";
    const isOpen = action === "open";

    if (isOpen) {
      return isLong ? (
        <ArrowUpRight className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <ArrowDownRight className="h-5 w-5 text-red-600 dark:text-red-400" />
      );
    }
    return isLong ? (
      <TrendingUp className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
    ) : (
      <TrendingDown className="h-5 w-5 text-red-600 dark:text-red-400" />
    );
  }

  if (isPostActivity(activity)) {
    return <MessageSquare className="h-5 w-5 text-primary" />;
  }

  if (isCommentActivity(activity)) {
    return (
      <MessageCircle className="h-5 w-5 text-violet-600 dark:text-violet-400" />
    );
  }

  if (isMessageActivity(activity)) {
    return (
      <MessageCircle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
    );
  }

  return <MessageSquare className="h-5 w-5 text-muted-foreground" />;
}

// Helper: Get icon background color
function getActivityIconBackground(activity: AgentActivity): string {
  if (isTradeActivity(activity)) {
    const isLong =
      activity.data.side === "long" || activity.data.side === "yes";
    return isLong
      ? "bg-emerald-100 dark:bg-emerald-900/30"
      : "bg-red-100 dark:bg-red-900/30";
  }

  if (isPostActivity(activity)) return "bg-primary/10";
  if (isCommentActivity(activity)) return "bg-violet-100 dark:bg-violet-900/30";
  if (isMessageActivity(activity)) return "bg-amber-100 dark:bg-amber-900/30";

  return "bg-muted";
}

// Helper: Get activity title
function getActivityTitle(activity: AgentActivity): string {
  if (isTradeActivity(activity)) {
    const { action, side, marketType } = activity.data;
    const sideLabel = side ? ` ${side.toUpperCase()}` : "";
    return `${action === "open" ? "Opened" : "Closed"}${sideLabel} ${marketType} position`;
  }

  if (isPostActivity(activity)) return "Created a post";

  if (isCommentActivity(activity)) {
    return activity.data.parentCommentId
      ? "Replied to a comment"
      : "Commented on a post";
  }

  if (isMessageActivity(activity)) return "Sent a message";

  return "Activity";
}

// Helper: Render activity-specific content
function renderActivityContent(activity: AgentActivity, expanded: boolean) {
  if (isTradeActivity(activity)) {
    const { marketType, ticker, marketQuestion, amount, price, reasoning } =
      activity.data;

    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            {marketType === "perp" ? ticker : "Prediction"}
          </span>
          <span className="text-muted-foreground/60">•</span>
          <span className="font-mono text-foreground">
            ${amount.toLocaleString()}
          </span>
          <span className="text-muted-foreground/60">@</span>
          <span className="font-mono text-foreground/80">
            {marketType === "perp"
              ? `$${price.toLocaleString()}`
              : `${(price * 100).toFixed(1)}%`}
          </span>
        </div>

        {marketQuestion && (
          <p className="line-clamp-2 text-muted-foreground text-sm">
            {marketQuestion}
          </p>
        )}

        {expanded && reasoning && (
          <div className="mt-3 rounded-md border border-border bg-muted/50 p-3">
            <p className="mb-1 font-medium text-muted-foreground text-xs uppercase">
              Reasoning
            </p>
            <p className="text-foreground/80 text-sm">{reasoning}</p>
          </div>
        )}
      </div>
    );
  }

  if (isPostActivity(activity)) {
    return (
      <p
        className={cn(
          "text-muted-foreground text-sm",
          expanded ? "" : "line-clamp-2",
        )}
      >
        {activity.data.contentPreview}
      </p>
    );
  }

  if (isCommentActivity(activity)) {
    return (
      <p
        className={cn(
          "text-muted-foreground text-sm",
          expanded ? "" : "line-clamp-2",
        )}
      >
        {activity.data.contentPreview}
      </p>
    );
  }

  if (isMessageActivity(activity)) {
    return (
      <p
        className={cn(
          "text-muted-foreground text-sm italic",
          expanded ? "" : "line-clamp-2",
        )}
      >
        {activity.data.contentPreview}
      </p>
    );
  }

  return null;
}

// Helper: P&L Badge component
function PnLBadge({ pnl }: { pnl: number }) {
  const isPositive = pnl >= 0;
  return (
    <div
      className={cn(
        "shrink-0 rounded-md px-2.5 py-1 font-medium font-mono text-sm",
        isPositive
          ? "border border-emerald-300 bg-emerald-100 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400"
          : "border border-red-300 bg-red-100 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-400",
      )}
    >
      {isPositive ? "+" : ""}$
      {pnl.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}
    </div>
  );
}

// Helper: Format time ago
function getTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  // Handle future dates (clock skew from SSE or timestamps)
  if (diffMs < 0) return "just now";

  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay === 1) return "yesterday";
  if (diffDay < 7) return `${diffDay}d ago`;

  return date.toLocaleDateString();
}
