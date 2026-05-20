'use client';

import { formatCurrency } from '@babylon/shared';
import { useMemo } from 'react';
import { calculateWalletPortfolioSummary } from '@/components/wallet/shared/portfolioBreakdown';
import {
  usePortfolioPnL,
  usePortfolioPnLPolling,
} from '@/hooks/usePortfolioPnL';
import { useUserPositions } from '@/stores/userPositionsStore';

interface BalanceTabProps {
  userId: string;
  onBuyPoints?: () => void;
}

export function BalanceTab({ userId, onBuyPoints }: BalanceTabProps) {
  const {
    data: portfolioData,
    error: portfolioError,
    loading: portfolioLoading,
  } = usePortfolioPnL({
    userId,
  });
  usePortfolioPnLPolling({ userId, intervalMs: 15_000 });

  const {
    perpPositions,
    predictionPositions,
    loading: positionsLoading,
  } = useUserPositions(userId);

  const loading = portfolioLoading || positionsLoading;

  const walletSummary = useMemo(() => {
    if (!portfolioData) {
      return null;
    }

    return calculateWalletPortfolioSummary({
      userId,
      snapshot: portfolioData,
      perpPositions,
      predictionPositions,
    });
  }, [portfolioData, predictionPositions, perpPositions, userId]);

  const fmt = (amount: number) =>
    formatCurrency(amount, { useThousandsSeparator: true });

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-24 animate-pulse rounded-xl bg-muted" />
        <div className="grid grid-cols-2 gap-3">
          <div className="h-16 animate-pulse rounded-xl bg-muted" />
          <div className="h-16 animate-pulse rounded-xl bg-muted" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  if (!walletSummary && portfolioError) {
    return (
      <div className="rounded-xl border border-border py-10 text-center">
        <p className="text-muted-foreground">Failed to load portfolio</p>
        <p className="mt-1 text-muted-foreground text-sm">{portfolioError}</p>
      </div>
    );
  }

  const members = walletSummary?.members ?? [];
  const owner = members.find((member) => member.isOwner) ?? members[0] ?? null;
  const agentMembers = members.filter((member) => !member.isOwner);
  const ownerCash = owner?.cash ?? 0;
  const totalBalance = walletSummary?.summary.totalBalance ?? 0;
  const openPositionsTotal = walletSummary?.summary.positions ?? 0;
  const agentsOnlyTotal = agentMembers.reduce(
    (sum, member) => sum + member.total,
    0
  );

  return (
    <div className="space-y-3 md:space-y-5">
      <div className="flex items-center justify-between rounded-xl border border-border bg-muted/30 px-3 py-2.5 md:p-5">
        <div>
          <div className="mb-1 text-muted-foreground text-xs tracking-wide">
            Total Portfolio Value
          </div>
          <div className="font-bold text-3xl tracking-tight">
            {fmt(totalBalance)}
          </div>
        </div>
        {onBuyPoints && (
          <button
            onClick={onBuyPoints}
            className="shrink-0 rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/90"
          >
            Buy Points
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 md:gap-3">
        <div className="rounded-xl border border-border px-3 py-2.5 md:p-4">
          <div className="mb-2 text-muted-foreground text-xs tracking-wide">
            Cash
          </div>
          <div className="font-semibold text-lg">{fmt(ownerCash)}</div>
        </div>
        <div className="rounded-xl border border-border px-3 py-2.5 md:p-4">
          <div className="mb-2 text-muted-foreground text-xs tracking-wide">
            Open Positions
          </div>
          <div className="font-semibold text-lg">{fmt(openPositionsTotal)}</div>
        </div>
      </div>

      {agentsOnlyTotal > 0 && (
        <div className="flex items-center justify-between rounded-xl border border-border px-3 py-2 md:px-5 md:py-3">
          <span className="text-muted-foreground text-sm">Agents Total</span>
          <span className="font-semibold text-sm">{fmt(agentsOnlyTotal)}</span>
        </div>
      )}
    </div>
  );
}
