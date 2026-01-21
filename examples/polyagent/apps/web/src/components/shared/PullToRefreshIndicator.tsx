import { cn } from "@polyagent/shared";

/**
 * Visual indicator component for pull-to-refresh gesture.
 *
 * Displays pull progress with arrow icon and text feedback. Shows spinner
 * during refresh. Smoothly animates height and opacity based on pull distance.
 * Pushes content down as user pulls.
 *
 * @param props - PullToRefreshIndicator component props
 * @returns Pull-to-refresh indicator element or null when not active
 *
 * @example
 * ```tsx
 * <PullToRefreshIndicator
 *   pullDistance={50}
 *   isRefreshing={false}
 *   threshold={80}
 * />
 * ```
 */
interface PullToRefreshIndicatorProps {
  pullDistance: number;
  isRefreshing: boolean;
  threshold?: number;
}

export function PullToRefreshIndicator({
  pullDistance,
  isRefreshing,
  threshold = 80,
}: PullToRefreshIndicatorProps) {
  // Fully hide when not pulling and not refreshing
  if (pullDistance === 0 && !isRefreshing) return null;

  const opacity = Math.min(pullDistance / threshold, 1);
  const isReady = pullDistance >= threshold;

  return (
    <div
      className={cn(
        "flex w-full items-center justify-center overflow-hidden bg-background",
        // Smooth collapse when refreshing ends
        !isRefreshing && pullDistance > 0
          ? "transition-all duration-300 ease-out"
          : "transition-opacity duration-100",
      )}
      style={{
        height: `${pullDistance}px`,
        opacity: isRefreshing ? 1 : opacity,
      }}
    >
      <div
        className={cn(
          "flex flex-col items-center gap-1 transition-colors duration-200",
          isReady || isRefreshing ? "text-[#3462f3]" : "text-muted-foreground",
        )}
      >
        <div
          className={cn(
            "transition-transform duration-200",
            isRefreshing && "animate-spin",
          )}
        >
          {isRefreshing ? (
            // Spinner during refresh
            <svg className="h-5 w-5" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          ) : (
            // Down arrow when pulling
            <svg
              className="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 14l-7 7m0 0l-7-7m7 7V3"
              />
            </svg>
          )}
        </div>
        <span className="whitespace-nowrap font-medium text-xs">
          {isRefreshing
            ? "Refreshing..."
            : isReady
              ? "Release to refresh"
              : "Pull to refresh"}
        </span>
      </div>
    </div>
  );
}
