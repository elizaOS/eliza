/**
 * NPC portfolio card component for displaying NPC actor portfolio data.
 *
 * Displays comprehensive portfolio information for an NPC actor including
 * total value, positions, PnL, utilization, and risk score. Shows position
 * details and portfolio metrics. Auto-refreshes every 10 seconds.
 *
 * Features:
 * - Portfolio value display
 * - Position list
 * - PnL breakdown (realized/unrealized)
 * - Utilization percentage
 * - Risk score indicator
 * - Auto-refresh (10s interval)
 * - Loading states
 * - Empty state handling
 *
 * @param props - NPCPortfolioCard component props
 * @returns NPC portfolio card element
 *
 * @example
 * ```tsx
 * <NPCPortfolioCard
 *   actorId="actor-123"
 *   showPositions={true}
 * />
 * ```
 */
'use client';

import { FEED_POINTS_SYMBOL, cn } from '@feed/shared';
import {
  Activity,
  AlertCircle,
  BarChart,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiUrl } from '@/utils/api-url';

/**
 * Position structure for NPC portfolio.
 */
interface Position {
  id: string;
  marketType: string;
  ticker: string | null;
  marketId: string | null;
  side: string;
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  leverage: number | null;
  createdAt: string;
}

/**
 * Portfolio structure for NPC portfolio card.
 */
interface Portfolio {
  totalValue: number;
  availableBalance: number;
  unrealizedPnL: number;
  realizedPnL: number;
  positionCount: number;
  utilization: number;
  riskScore: number;
}

/**
 * Portfolio data structure from API.
 */
interface PortfolioData {
  success: boolean;
  actorId: string;
  actorName: string;
  poolId?: string;
  portfolio: Portfolio;
  positions: Position[];
}

interface NPCPortfolioCardProps {
  actorId: string;
  className?: string;
  showPositions?: boolean;
}

export function NPCPortfolioCard({
  actorId,
  className = '',
  showPositions = true,
}: NPCPortfolioCardProps) {
  const [data, setData] = useState<PortfolioData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchPortfolio = async () => {
      setLoading(true);
      const response = await fetch(
        apiUrl(`/api/npc/${encodeURIComponent(actorId)}/portfolio`)
      );
      const result = await response.json();

      if (result.success) {
        setData(result);
      }
      setLoading(false);
    };

    fetchPortfolio();

    // Refresh every 10 seconds
    const interval = setInterval(fetchPortfolio, 10000);
    return () => clearInterval(interval);
  }, [actorId]);

  if (loading) {
    return (
      <div className={cn('rounded-2xl bg-sidebar px-4 py-3', className)}>
        <div className="text-muted-foreground text-sm">
          Loading portfolio...
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className={cn('rounded-2xl bg-sidebar px-4 py-3', className)}>
        <div className="text-muted-foreground text-sm">
          Portfolio data unavailable
        </div>
      </div>
    );
  }

  const { portfolio, positions } = data;

  const getRiskColor = (riskScore: number) => {
    if (riskScore >= 0.7) return 'text-red-500';
    if (riskScore >= 0.4) return 'text-yellow-500';
    return 'text-green-500';
  };

  const getRiskLabel = (riskScore: number) => {
    if (riskScore >= 0.7) return 'High Risk';
    if (riskScore >= 0.4) return 'Moderate';
    return 'Low Risk';
  };

  return (
    <div
      className={cn('space-y-4 rounded-2xl bg-sidebar px-4 py-3', className)}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-3 font-bold text-foreground text-lg">
          <Wallet className="h-5 w-5 text-blue-500" />
          {data.actorName} Portfolio
        </h3>
        <div
          className={cn(
            'font-medium text-sm',
            getRiskColor(portfolio.riskScore)
          )}
        >
          {getRiskLabel(portfolio.riskScore)}
        </div>
      </div>

      {/* Portfolio Value */}
      <div className="rounded-lg bg-muted/30 px-4 py-3">
        <div className="mb-1 text-muted-foreground text-xs">
          Total Portfolio Value
        </div>
        <div className="font-bold text-3xl text-foreground">
          {FEED_POINTS_SYMBOL}
          {portfolio.totalValue.toLocaleString()}
        </div>
        <div className="mt-2 flex items-center gap-4">
          <div className="flex items-center gap-1 text-sm">
            {portfolio.unrealizedPnL >= 0 ? (
              <TrendingUp className="h-4 w-4 text-green-500" />
            ) : (
              <TrendingDown className="h-4 w-4 text-red-500" />
            )}
            <span
              className={
                portfolio.unrealizedPnL >= 0 ? 'text-green-500' : 'text-red-500'
              }
            >
              {FEED_POINTS_SYMBOL}
              {Math.abs(portfolio.unrealizedPnL).toLocaleString()}
            </span>
            <span className="text-muted-foreground text-xs">unrealized</span>
          </div>
          {portfolio.realizedPnL !== 0 && (
            <div className="flex items-center gap-1 text-muted-foreground text-sm">
              <span
                className={
                  portfolio.realizedPnL >= 0 ? 'text-green-500' : 'text-red-500'
                }
              >
                {FEED_POINTS_SYMBOL}
                {Math.abs(portfolio.realizedPnL).toLocaleString()}
              </span>
              <span className="text-xs">realized</span>
            </div>
          )}
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-3 gap-3">
        {/* Available Balance */}
        <div className="rounded-lg bg-muted/30 p-3">
          <div className="mb-1 text-muted-foreground text-xs">Available</div>
          <div className="font-bold text-foreground text-lg">
            {FEED_POINTS_SYMBOL}
            {portfolio.availableBalance.toLocaleString()}
          </div>
        </div>

        {/* Utilization */}
        <div className="rounded-lg bg-muted/30 p-3">
          <div className="mb-1 text-muted-foreground text-xs">Utilization</div>
          <div className="font-bold text-foreground text-lg">
            {portfolio.utilization.toFixed(1)}%
          </div>
          <div className="mt-1 h-1 w-full rounded-full bg-muted/30">
            <div
              className="h-1 rounded-full bg-blue-500"
              style={{ width: `${Math.min(100, portfolio.utilization)}%` }}
            />
          </div>
        </div>

        {/* Open Positions */}
        <div className="rounded-lg bg-muted/30 p-3">
          <div className="mb-1 text-muted-foreground text-xs">Positions</div>
          <div className="flex items-center gap-1 font-bold text-foreground text-lg">
            <Activity className="h-4 w-4" />
            {portfolio.positionCount}
          </div>
        </div>
      </div>

      {/* Positions List */}
      {showPositions && positions.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-3 font-medium text-foreground text-sm">
            <BarChart className="h-4 w-4" />
            Open Positions
          </div>
          <div className="space-y-1">
            {positions.map((position) => (
              <div
                key={position.id}
                className="flex items-center justify-between rounded bg-muted/30 p-2 text-xs"
              >
                <div className="flex items-center gap-3">
                  {position.side === 'long' || position.side === 'buy' ? (
                    <TrendingUp className="h-3 w-3 text-green-500" />
                  ) : (
                    <TrendingDown className="h-3 w-3 text-red-500" />
                  )}
                  <span className="font-medium text-foreground">
                    {position.ticker || position.marketId}
                  </span>
                  <span className="text-muted-foreground uppercase">
                    {position.side}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground">
                    {FEED_POINTS_SYMBOL}
                    {position.size.toLocaleString()}
                  </span>
                  {position.leverage && position.leverage > 1 && (
                    <span className="text-yellow-500">
                      {position.leverage}x
                    </span>
                  )}
                  <span
                    className={
                      position.unrealizedPnL >= 0
                        ? 'text-green-500'
                        : 'text-red-500'
                    }
                  >
                    {position.unrealizedPnL >= 0 ? '+' : ''}
                    {FEED_POINTS_SYMBOL}
                    {position.unrealizedPnL.toLocaleString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Risk Warning */}
      {portfolio.riskScore >= 0.7 && (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-3">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
          <div className="text-red-500 text-xs">
            High risk score detected. Portfolio may be overexposed or highly
            leveraged.
          </div>
        </div>
      )}
    </div>
  );
}
