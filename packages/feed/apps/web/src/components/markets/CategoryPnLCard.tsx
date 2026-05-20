import { cn } from '@feed/shared';
import { ArrowDownRight, ArrowUpRight, RefreshCcw, Share2 } from 'lucide-react';
import { formatCurrencyDisplay } from '@/lib/format';

/**
 * Market category type for category PnL card.
 */
type MarketCategory = 'perps' | 'predictions';

/**
 * Category PnL data structure for category PnL card.
 */
interface CategoryPnLData {
  unrealizedPnL: number;
  positionCount: number;
  totalValue?: number;
  categorySpecific?: {
    // For perps
    openInterest?: number;
    // For predictions
    totalShares?: number;
    // For pools
    totalInvested?: number;
  };
}

/**
 * Category PnL card component for displaying category-specific portfolio PnL.
 *
 * Displays unrealized PnL and position count for a specific market category
 * (perpetuals or predictions). Includes share functionality and refresh
 * capability. Shows last updated timestamp.
 *
 * Features:
 * - Unrealized PnL display
 * - Position count
 * - Category-specific metrics
 * - Share functionality
 * - Refresh functionality
 * - Last updated timestamp
 * - Loading states
 * - Error handling
 *
 * @param props - CategoryPnLCard component props
 * @returns Category PnL card element
 *
 * @example
 * ```tsx
 * <CategoryPnLCard
 *   category="perps"
 *   data={pnlData}
 *   loading={false}
 *   onShare={() => sharePnL()}
 *   onRefresh={() => refreshData()}
 * />
 * ```
 */
interface CategoryPnLCardProps {
  category: MarketCategory;
  data: CategoryPnLData | null;
  loading: boolean;
  error: string | null;
  onShare: () => void;
  onRefresh: () => void;
  lastUpdated: number | null;
}

/**
 * Format relative time from timestamp.
 *
 * Formats a timestamp as relative time (e.g., "5m ago", "2h ago").
 *
 * @param timestamp - Timestamp to format
 * @returns Formatted relative time string
 */
function formatRelativeTime(timestamp: number | null) {
  if (!timestamp) return '';
  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) return '';
  const diffMinutes = Math.round(diffMs / (1000 * 60));
  if (diffMinutes <= 1) return 'Updated just now';
  if (diffMinutes < 60) return `Updated ${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `Updated ${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  return `Updated ${diffDays}d ago`;
}

/**
 * Category configuration for styling and display.
 */
const categoryConfig = {
  perps: {
    title: 'Perpetual Futures P&L',
    color: 'from-green-500/10 via-emerald-500/10 to-green-500/5',
    border: 'border-green-500/20',
  },
  predictions: {
    title: 'Prediction Markets P&L',
    color: 'from-purple-500/10 via-violet-500/10 to-purple-500/5',
    border: 'border-purple-500/20',
  },
  pools: {
    title: 'Trading Pools P&L',
    color: 'from-orange-500/10 via-amber-500/10 to-orange-500/5',
    border: 'border-orange-500/20',
  },
};

export function CategoryPnLCard({
  category,
  data,
  loading,
  error,
  onShare,
  onRefresh,
  lastUpdated,
}: CategoryPnLCardProps) {
  const config = categoryConfig[category];
  const pnl = data?.unrealizedPnL ?? 0;
  const pnlIsPositive = pnl >= 0;

  return (
    <section
      className={cn(
        'rounded-2xl border bg-gradient-to-br px-4 py-3 shadow-sm sm:px-5 sm:py-4',
        config.border,
        config.color
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
            {config.title}
          </h2>
          <p className="text-muted-foreground text-xs">
            {formatRelativeTime(lastUpdated)}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="flex items-center justify-center rounded-lg border border-white/10 bg-white/10 p-2 text-foreground backdrop-blur transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label={`Refresh ${category} P&L`}
          >
            <RefreshCcw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </button>
          <button
            type="button"
            onClick={onShare}
            disabled={loading || !data}
            className="inline-flex items-center gap-3 rounded-lg bg-white/90 px-3 py-3 font-semibold text-[#0B1C3D] text-sm shadow transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Share2 className="h-4 w-4" />
            Share
          </button>
        </div>
      </div>

      {loading ? (
        <div className="mt-6 space-y-4">
          <div className="h-10 w-64 animate-pulse rounded bg-white/20" />
          <div className="grid grid-cols-2 gap-3">
            {[1, 2].map((key) => (
              <div key={key} className="h-16 rounded-lg bg-white/10" />
            ))}
          </div>
        </div>
      ) : error ? (
        <div className="mt-6 rounded-lg bg-white/10 px-4 py-3 text-foreground/80 text-sm">
          <p className="font-medium text-foreground">Unable to load P&amp;L</p>
          <p className="mt-1 text-foreground/80">{error}</p>
        </div>
      ) : (
        data && (
          <>
            <div className="mt-6 flex items-center gap-3">
              <div
                className={cn(
                  'inline-flex items-center gap-3 rounded-full px-3 py-2 font-semibold text-sm',
                  pnlIsPositive
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : 'bg-red-500/20 text-red-400'
                )}
              >
                {pnlIsPositive ? (
                  <ArrowUpRight className="h-4 w-4" />
                ) : (
                  <ArrowDownRight className="h-4 w-4" />
                )}
                {pnlIsPositive ? 'Profit' : 'Loss'}
              </div>
              <p className="font-bold text-4xl text-foreground sm:text-5xl">
                {pnlIsPositive ? '+' : ''}
                {formatCurrencyDisplay(pnl)}
              </p>
            </div>

            <dl className="mt-6 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div className="rounded-lg border border-white/10 bg-white/10 p-3 backdrop-blur">
                <dt className="text-foreground/70 text-xs uppercase">
                  Open Positions
                </dt>
                <dd className="font-semibold text-base text-foreground">
                  {data.positionCount}
                </dd>
              </div>
              {data.totalValue !== undefined && (
                <div className="rounded-lg border border-white/10 bg-white/10 p-3 backdrop-blur">
                  <dt className="text-foreground/70 text-xs uppercase">
                    Total Value
                  </dt>
                  <dd className="font-semibold text-base text-foreground">
                    {formatCurrencyDisplay(data.totalValue)}
                  </dd>
                </div>
              )}
              {data.categorySpecific?.openInterest !== undefined && (
                <div className="rounded-lg border border-white/10 bg-white/10 p-3 backdrop-blur">
                  <dt className="text-foreground/70 text-xs uppercase">
                    Open Interest
                  </dt>
                  <dd className="font-semibold text-base text-foreground">
                    {formatCurrencyDisplay(data.categorySpecific.openInterest)}
                  </dd>
                </div>
              )}
              {data.categorySpecific?.totalShares !== undefined && (
                <div className="rounded-lg border border-white/10 bg-white/10 p-3 backdrop-blur">
                  <dt className="text-foreground/70 text-xs uppercase">
                    Total Shares
                  </dt>
                  <dd className="font-semibold text-base text-foreground">
                    {data.categorySpecific.totalShares.toFixed(2)}
                  </dd>
                </div>
              )}
              {data.categorySpecific?.totalInvested !== undefined && (
                <div className="rounded-lg border border-white/10 bg-white/10 p-3 backdrop-blur">
                  <dt className="text-foreground/70 text-xs uppercase">
                    Total Invested
                  </dt>
                  <dd className="font-semibold text-base text-foreground">
                    {formatCurrencyDisplay(data.categorySpecific.totalInvested)}
                  </dd>
                </div>
              )}
            </dl>
          </>
        )
      )}
    </section>
  );
}
