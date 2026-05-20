'use client';

import {
  FEED_POINTS_SYMBOL,
  cn,
  formatCompactCurrency,
  logger,
} from '@feed/shared';
import {
  ChevronDown,
  ExternalLink,
  Loader2,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { useAgent0Reputation } from '@/hooks/useAgent0Reputation';
import { useAgentTotalPnL } from '@/hooks/useAgentTotalPnL';
import { useAuth } from '@/hooks/useAuth';
import { useCollapsibleHeight } from '@/hooks/useCollapsibleHeight';
import { usePortfolioPnL } from '@/hooks/usePortfolioPnL';
import type { UserPositionsSnapshot } from '@/lib/markets/user-positions-types';
import {
  usePerpPositions,
  usePredictionPositions,
} from '@/stores/userPositionsStore';

/** Portfolio breakdown snapshot (matches profile page calculation) */
interface PortfolioSnapshot {
  totalPnL: number;
  positions: number;
  totalAssets: number;
  available: number;
  wallet: number;
  agents: number;
}

interface AgentSidebarSummaryResponse {
  success: boolean;
  agent: {
    totalTrades: number;
    profitableTrades: number;
    winRate: number;
    virtualBalance?: number;
    totalDeposited?: number | null;
    totalWithdrawn?: number | null;
    lifetimePnL?: number;
  };
  portfolio: PortfolioSnapshot;
  positions: UserPositionsSnapshot;
}

type AgentPnLProps =
  | {
      entityType: 'agent';
      agentId: string;
      entityName: string;
      userId?: never;
    }
  | {
      entityType: 'user';
      userId: string;
      entityName: string;
      agentId?: never;
    };

/** Returns true if a prediction position is still open (not resolved/closed) */
function isOpenPrediction(p: { resolved?: boolean; status?: string }): boolean {
  if (p.resolved) return false;
  if (p.status && p.status !== 'active') return false;
  return true;
}

/** Returns a label + color variant for a closed prediction position */
function getResolutionLabel(p: {
  resolution?: boolean | null;
  status?: string;
}): { text: string; variant: 'green' | 'red' | 'muted' } {
  if (p.status === 'cancelled') return { text: 'Cancelled', variant: 'muted' };
  if (p.resolution === true) return { text: 'Won', variant: 'green' };
  if (p.resolution === false) return { text: 'Lost', variant: 'red' };
  return { text: 'Closed', variant: 'muted' };
}

/** Collapsible section with smooth height animation */
function CollapsibleSection({
  title,
  count,
  isOpen,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const { contentRef, height } = useCollapsibleHeight(isOpen);

  return (
    <div className="rounded-md border border-border/50 bg-muted/20">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-2 py-1.5 text-left transition-colors hover:bg-muted/30"
      >
        <span className="font-medium text-[11px] text-muted-foreground uppercase">
          {title} ({count})
        </span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 text-muted-foreground transition-transform duration-200',
            isOpen && 'rotate-180'
          )}
        />
      </button>
      <div
        style={{
          height: height === undefined ? 'auto' : height,
          overflow: 'hidden',
          transition: 'height 200ms ease-out',
        }}
      >
        <div ref={contentRef} className="px-2 pb-2">
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * P&L component showing trading performance, stats, and open positions.
 * Supports both user and agent modes.
 */
export function AgentPnL(props: AgentPnLProps) {
  const { entityType, entityName } = props;

  if (entityType === 'user') {
    return <UserPnL userId={props.userId} entityName={entityName} />;
  }

  return <AgentPnLView agentId={props.agentId} entityName={entityName} />;
}

/** User P&L view - uses portfolio-breakdown for consistent P&L (matches profile page) */
function UserPnL({
  userId,
  entityName,
}: {
  userId: string;
  entityName: string;
}) {
  const router = useRouter();
  const [expandedSections, setExpandedSections] = useState<
    Set<'predictions' | 'perps'>
  >(new Set(['predictions', 'perps']));
  const [showClosed, setShowClosed] = useState(false);

  const { data: portfolio, loading: portfolioLoading } = usePortfolioPnL({
    userId,
  });

  // Fetch user positions (for list display only)
  const { positions: perpsData, loading: perpsLoading } =
    usePerpPositions(userId);
  const { positions: predictionsData, loading: predictionsLoading } =
    usePredictionPositions(userId);

  const loading = portfolioLoading || perpsLoading || predictionsLoading;

  // Filter to only user's personal positions (exclude agent positions)
  const perps = (perpsData ?? []).filter((p) => !p.isAgentPosition);
  const userPredictions = (predictionsData ?? []).filter(
    (p) => !p.isAgentPosition
  );
  const openPredictions = userPredictions.filter(isOpenPrediction);
  const closedPredictions = userPredictions.filter((p) => !isOpenPrediction(p));
  const predictions = showClosed
    ? [...openPredictions, ...closedPredictions]
    : openPredictions;

  const toggleSection = useCallback((section: 'predictions' | 'perps') => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const totalPnL = portfolio?.totalPnL ?? 0;
  const isProfitable = totalPnL >= 0;

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">{entityName} P&L</h3>
        <div
          className={cn(
            'flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-xs',
            isProfitable
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
              : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
          )}
        >
          {isProfitable ? (
            <TrendingUp className="h-3 w-3" />
          ) : (
            <TrendingDown className="h-3 w-3" />
          )}
          {totalPnL >= 0 ? '+' : ''}
          {formatCompactCurrency(totalPnL)}
        </div>
      </div>

      {/* Quick Stats Row */}
      <div className="flex items-stretch rounded-lg border border-border/60 bg-card/50">
        <div className="flex flex-1 flex-col items-center justify-center px-1 py-2">
          <span className="font-semibold text-foreground text-xs">
            {formatCompactCurrency(portfolio?.wallet ?? 0)}
          </span>
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
            Balance
          </span>
        </div>
        <div className="w-px bg-border/60" />
        <div className="flex flex-1 flex-col items-center justify-center px-1 py-2">
          <span className="font-semibold text-foreground text-xs">
            {formatCompactCurrency(portfolio?.totalAssets ?? 0)}
          </span>
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
            Assets
          </span>
        </div>
        <div className="w-px bg-border/60" />
        <div className="flex flex-1 flex-col items-center justify-center px-1 py-2">
          <span className="font-semibold text-foreground text-xs">
            {predictions.length + perps.length}
          </span>
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
            Positions
          </span>
        </div>
      </div>

      {/* P&L Breakdown */}
      <div className="space-y-1.5 rounded-lg border border-border bg-card/50 p-3">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Total P&L</span>
          <span
            className={cn(
              'font-semibold',
              isProfitable ? 'text-green-600' : 'text-red-600'
            )}
          >
            {totalPnL >= 0 ? '+' : ''}
            {formatCompactCurrency(totalPnL)}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Available</span>
          <span className="font-medium">
            {formatCompactCurrency(portfolio?.available ?? 0)}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">In Positions</span>
          <span className="font-medium">
            {formatCompactCurrency(portfolio?.positions ?? 0)}
          </span>
        </div>
        <div className="flex items-center justify-between border-border border-t pt-1.5 text-xs">
          <span className="text-muted-foreground">Predictions</span>
          <span className="font-medium">{predictions.length}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Perpetuals</span>
          <span className="font-medium">{perps.length}</span>
        </div>
      </div>

      {/* Open Positions */}
      <div className="flex flex-col rounded-lg border border-border bg-card/50 p-3 lg:min-h-0 lg:flex-1 lg:overflow-hidden">
        <div className="mb-2 flex shrink-0 items-center justify-between">
          <span className="font-medium text-sm">
            {showClosed ? 'All Positions' : 'Open Positions'}
          </span>
          {closedPredictions.length > 0 && (
            <label className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <span>Show closed</span>
              <Switch
                checked={showClosed}
                onCheckedChange={setShowClosed}
                className="scale-75"
              />
            </label>
          )}
        </div>

        {predictions.length === 0 && perps.length === 0 ? (
          <div className="flex items-center justify-center py-4 text-muted-foreground text-xs">
            {showClosed ? 'No positions' : 'No open positions'}
          </div>
        ) : (
          <div className="space-y-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            {/* Prediction Positions */}
            {predictions.length > 0 && (
              <CollapsibleSection
                title="Predictions"
                count={predictions.length}
                isOpen={expandedSections.has('predictions')}
                onToggle={() => toggleSection('predictions')}
              >
                <div className="space-y-1">
                  {predictions.map((pos) => {
                    const closed = !isOpenPrediction(pos);
                    const resolution = closed ? getResolutionLabel(pos) : null;
                    return (
                      <button
                        type="button"
                        key={pos.id}
                        onClick={() =>
                          router.push(`/markets/predictions/${pos.marketId}`)
                        }
                        className={cn(
                          'flex w-full items-center justify-between rounded bg-muted/30 px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/50',
                          closed && 'opacity-60'
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 truncate font-medium">
                            <span className="truncate">
                              {pos.question || `Market ${pos.marketId}`}
                            </span>
                            {closed && (
                              <span
                                className={cn(
                                  'shrink-0 rounded-full px-1.5 py-0.5 font-medium text-[10px] leading-none',
                                  {
                                    'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400':
                                      resolution?.variant === 'green',
                                    'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400':
                                      resolution?.variant === 'red',
                                    'bg-muted text-muted-foreground':
                                      resolution?.variant === 'muted',
                                  }
                                )}
                              >
                                {resolution?.text}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <span
                              className={cn(
                                'font-medium',
                                pos.side === 'YES'
                                  ? 'text-green-600'
                                  : 'text-red-600'
                              )}
                            >
                              {pos.side}
                            </span>
                            <span>{Number(pos.shares).toFixed(2)} shares</span>
                          </div>
                        </div>
                        {pos.unrealizedPnL !== undefined && (
                          <span
                            className={cn(
                              'ml-2 shrink-0 font-medium',
                              Number(pos.unrealizedPnL) >= 0
                                ? 'text-green-600'
                                : 'text-red-600'
                            )}
                          >
                            {Number(pos.unrealizedPnL) >= 0 ? '+' : ''}
                            {formatCompactCurrency(Number(pos.unrealizedPnL))}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </CollapsibleSection>
            )}

            {/* Perp Positions */}
            {perps.length > 0 && (
              <CollapsibleSection
                title="Perpetuals"
                count={perps.length}
                isOpen={expandedSections.has('perps')}
                onToggle={() => toggleSection('perps')}
              >
                <div className="space-y-1">
                  {perps.map((pos) => (
                    <button
                      type="button"
                      key={pos.id}
                      onClick={() =>
                        router.push(`/markets/perps/${pos.ticker}`)
                      }
                      className="flex w-full items-center justify-between rounded bg-muted/30 px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/50"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{pos.ticker}</div>
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <span
                            className={cn(
                              'font-medium',
                              pos.side === 'long'
                                ? 'text-green-600'
                                : 'text-red-600'
                            )}
                          >
                            {pos.side.toUpperCase()}
                          </span>
                          <span>Size: {Number(pos.size).toFixed(4)}</span>
                          {pos.entryPrice && (
                            <span>
                              @ {FEED_POINTS_SYMBOL}
                              {Number(pos.entryPrice).toFixed(2)}
                            </span>
                          )}
                        </div>
                      </div>
                      {pos.unrealizedPnL !== undefined && (
                        <span
                          className={cn(
                            'ml-2 shrink-0 font-medium',
                            Number(pos.unrealizedPnL) >= 0
                              ? 'text-green-600'
                              : 'text-red-600'
                          )}
                        >
                          {Number(pos.unrealizedPnL) >= 0 ? '+' : ''}
                          {formatCompactCurrency(Number(pos.unrealizedPnL))}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </CollapsibleSection>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Agent P&L view - uses portfolio-breakdown for consistent P&L (matches profile page) */
function AgentPnLView({
  agentId,
  entityName,
}: {
  agentId: string;
  entityName: string;
}) {
  const router = useRouter();
  const { getAccessToken } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<
    Set<'predictions' | 'perps'>
  >(new Set(['predictions', 'perps']));
  const [showClosed, setShowClosed] = useState(false);
  const [summary, setSummary] = useState<AgentSidebarSummaryResponse | null>(
    null
  );

  const agentRow = summary?.agent;
  const {
    totalPnL: hookTotalPnL,
    isProfitable: hookIsProfitable,
    loading: hookPnlLoading,
  } = useAgentTotalPnL({
    agentId,
    availableBalance: agentRow?.virtualBalance ?? 0,
    totalDeposited: agentRow?.totalDeposited ?? undefined,
    totalWithdrawn: agentRow?.totalWithdrawn ?? undefined,
    realizedPnL: agentRow?.lifetimePnL,
  });

  const {
    profile: agent0Profile,
    loading: agent0Loading,
    isAgent0Available,
  } = useAgent0Reputation(agentId);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();

    const fetchSummary = async () => {
      setLoading(true);
      setError(null);

      try {
        const token = await getAccessToken();
        if (!token) {
          throw new Error('Authentication required');
        }

        const response = await fetch(`/api/agents/${agentId}/summary`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          signal: abort.signal,
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch agent summary (${response.status})`);
        }

        const data = (await response.json()) as AgentSidebarSummaryResponse;
        if (!data.success) {
          throw new Error('Failed to fetch agent summary');
        }

        if (cancelled) {
          return;
        }

        setSummary(data);
      } catch (err) {
        if (cancelled) {
          return;
        }

        const message =
          err instanceof Error ? err.message : 'Failed to load agent summary';
        setError(message);
        logger.error(
          'Failed to fetch agent sidebar summary',
          { error: message, agentId },
          'AgentPnLView'
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void fetchSummary();

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [agentId, getAccessToken]);

  const allPredictions = summary?.positions.predictions.positions ?? [];
  const allPerps = summary?.positions.perpetuals.positions ?? [];
  const openPredictions = allPredictions.filter(isOpenPrediction);
  const closedPredictions = allPredictions.filter(
    (position) => !isOpenPrediction(position)
  );
  const openPerps = allPerps.filter((position) => !position.closedAt);
  const closedPerps = allPerps.filter((position) => Boolean(position.closedAt));
  const predictions = showClosed
    ? [...openPredictions, ...closedPredictions]
    : openPredictions;
  const perps = showClosed ? [...openPerps, ...closedPerps] : openPerps;

  const toggleSection = useCallback((section: 'predictions' | 'perps') => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="p-4 text-muted-foreground text-sm">
        Failed to load agent P&L: {error ?? 'Unknown error'}
      </div>
    );
  }

  const totalPnL = hookPnlLoading ? summary.portfolio.totalPnL : hookTotalPnL;
  const isProfitable = hookPnlLoading
    ? summary.portfolio.totalPnL >= 0
    : hookIsProfitable;

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* Header with agent name */}
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">{entityName} P&L</h3>
        <div
          className={cn(
            'flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-xs',
            isProfitable
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
              : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
          )}
        >
          {isProfitable ? (
            <TrendingUp className="h-3 w-3" />
          ) : (
            <TrendingDown className="h-3 w-3" />
          )}
          {totalPnL >= 0 ? '+' : ''}
          {formatCompactCurrency(totalPnL)}
        </div>
      </div>

      {/* Quick Stats Row */}
      <div className="flex items-stretch rounded-lg border border-border/60 bg-card/50">
        <div className="flex flex-1 flex-col items-center justify-center px-1 py-2">
          <span className="font-semibold text-foreground text-xs">
            {summary.agent.totalTrades}
          </span>
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
            Trades
          </span>
        </div>
        <div className="w-px bg-border/60" />
        <div className="flex flex-1 flex-col items-center justify-center px-1 py-2">
          <span className="font-semibold text-foreground text-xs">
            {(summary.agent.winRate * 100).toFixed(0)}%
          </span>
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
            Win Rate
          </span>
        </div>
        <div className="w-px bg-border/60" />
        <div className="flex flex-1 flex-col items-center justify-center px-1 py-2">
          <span className="font-semibold text-foreground text-xs">
            {predictions.length + perps.length}
          </span>
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
            Positions
          </span>
        </div>
        <div className="w-px bg-border/60" />
        <div className="flex flex-1 flex-col items-center justify-center px-1 py-2">
          <span className="font-semibold text-green-600 text-xs">
            {summary.agent.profitableTrades}
          </span>
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
            Profitable
          </span>
        </div>
      </div>

      {(agent0Loading || isAgent0Available) && (
        <div className="rounded-lg border border-border/60 bg-card/50 px-3 py-2 text-xs">
          {agent0Loading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Agent0…
            </div>
          ) : isAgent0Available && agent0Profile ? (
            <a
              href={`https://agent0.network/agent/${agent0Profile.tokenId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between gap-2 text-foreground transition-colors hover:text-[#0066FF]"
            >
              <span className="truncate">
                Agent0 · Trust{' '}
                {agent0Profile.reputation?.trustScore != null
                  ? agent0Profile.reputation.trustScore.toFixed(0)
                  : '—'}
                %
              </span>
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          ) : null}
        </div>
      )}

      {/* P&L Breakdown */}
      <div className="space-y-1.5 rounded-lg border border-border bg-card/50 p-3">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Total P&L</span>
          <span
            className={cn(
              'font-semibold',
              isProfitable ? 'text-green-600' : 'text-red-600'
            )}
          >
            {totalPnL >= 0 ? '+' : ''}
            {formatCompactCurrency(totalPnL)}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Total Assets</span>
          <span className="font-medium">
            {formatCompactCurrency(summary.portfolio.totalAssets)}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Available</span>
          <span className="font-medium">
            {formatCompactCurrency(summary.portfolio.available)}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">In Positions</span>
          <span className="font-medium">
            {formatCompactCurrency(summary.portfolio.positions)}
          </span>
        </div>
      </div>

      {/* Open Positions */}
      <div className="flex flex-col rounded-lg border border-border bg-card/50 p-3 lg:min-h-0 lg:flex-1 lg:overflow-hidden">
        <div className="mb-2 flex shrink-0 items-center justify-between">
          <span className="font-medium text-sm">
            {showClosed ? 'All Positions' : 'Open Positions'}
          </span>
          {(closedPredictions.length > 0 || closedPerps.length > 0) && (
            <label className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <span>Show closed</span>
              <Switch
                checked={showClosed}
                onCheckedChange={setShowClosed}
                className="scale-75"
              />
            </label>
          )}
        </div>

        {predictions.length === 0 && perps.length === 0 ? (
          <div className="flex items-center justify-center py-4 text-muted-foreground text-xs">
            {showClosed ? 'No positions' : 'No open positions'}
          </div>
        ) : (
          <div className="space-y-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            {/* Prediction Positions */}
            {predictions.length > 0 && (
              <CollapsibleSection
                title="Predictions"
                count={predictions.length}
                isOpen={expandedSections.has('predictions')}
                onToggle={() => toggleSection('predictions')}
              >
                <div className="space-y-1">
                  {predictions.map((pos) => {
                    const closed = !isOpenPrediction(pos);
                    const resolution = closed ? getResolutionLabel(pos) : null;
                    return (
                      <button
                        type="button"
                        key={pos.id}
                        onClick={() =>
                          router.push(`/markets/predictions/${pos.marketId}`)
                        }
                        className={cn(
                          'flex w-full items-center justify-between rounded bg-muted/30 px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/50',
                          closed && 'opacity-60'
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 truncate font-medium">
                            <span className="truncate">
                              {pos.question || `Market ${pos.marketId}`}
                            </span>
                            {closed && (
                              <span
                                className={cn(
                                  'shrink-0 rounded-full px-1.5 py-0.5 font-medium text-[10px] leading-none',
                                  {
                                    'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400':
                                      resolution?.variant === 'green',
                                    'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400':
                                      resolution?.variant === 'red',
                                    'bg-muted text-muted-foreground':
                                      resolution?.variant === 'muted',
                                  }
                                )}
                              >
                                {resolution?.text}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <span
                              className={cn(
                                'font-medium',
                                pos.side === 'YES'
                                  ? 'text-green-600'
                                  : 'text-red-600'
                              )}
                            >
                              {pos.side}
                            </span>
                            <span>{Number(pos.shares).toFixed(2)} shares</span>
                          </div>
                        </div>
                        {pos.unrealizedPnL !== undefined && (
                          <span
                            className={cn(
                              'ml-2 shrink-0 font-medium',
                              Number(pos.unrealizedPnL) >= 0
                                ? 'text-green-600'
                                : 'text-red-600'
                            )}
                          >
                            {Number(pos.unrealizedPnL) >= 0 ? '+' : ''}
                            {formatCompactCurrency(Number(pos.unrealizedPnL))}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </CollapsibleSection>
            )}

            {/* Perp Positions */}
            {perps.length > 0 && (
              <CollapsibleSection
                title="Perpetuals"
                count={perps.length}
                isOpen={expandedSections.has('perps')}
                onToggle={() => toggleSection('perps')}
              >
                <div className="space-y-1">
                  {perps.map((pos) => (
                    <button
                      type="button"
                      key={pos.id}
                      onClick={() =>
                        router.push(`/markets/perps/${pos.ticker}`)
                      }
                      className="flex w-full items-center justify-between rounded bg-muted/30 px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/50"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{pos.ticker}</div>
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <span
                            className={cn(
                              'font-medium',
                              pos.side === 'long'
                                ? 'text-green-600'
                                : 'text-red-600'
                            )}
                          >
                            {pos.side.toUpperCase()}
                          </span>
                          <span>Size: {Number(pos.size).toFixed(4)}</span>
                          {pos.entryPrice && (
                            <span>
                              @ {FEED_POINTS_SYMBOL}
                              {Number(pos.entryPrice).toFixed(2)}
                            </span>
                          )}
                        </div>
                      </div>
                      {pos.unrealizedPnL !== undefined && (
                        <span
                          className={cn(
                            'ml-2 shrink-0 font-medium',
                            Number(pos.unrealizedPnL) >= 0
                              ? 'text-green-600'
                              : 'text-red-600'
                          )}
                        >
                          {Number(pos.unrealizedPnL) >= 0 ? '+' : ''}
                          {formatCompactCurrency(Number(pos.unrealizedPnL))}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </CollapsibleSection>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
