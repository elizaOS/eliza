'use client';

import { cn } from '@feed/shared';
import { Minus } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { AssetTradesFeed } from '@/components/markets/AssetTradesFeed';
import { PerpPositionsList } from '@/components/markets/PerpPositionsList';
import { useAuth } from '@/hooks/useAuth';
import { invalidatePerpMarketsCache } from '@/stores/perpMarketsStore';
import {
  invalidateUserPositions,
  usePerpPositions,
} from '@/stores/userPositionsStore';
import { invalidateWalletBalance } from '@/stores/walletBalanceStore';

export type PerpsTerminalBottomTab =
  | 'agent'
  | 'socials'
  | 'pnl'
  | 'positions'
  | 'orders'
  | 'trades';

interface PerpsTerminalBottomPanelProps {
  ticker: string | null;
  activeTab?: PerpsTerminalBottomTab;
  onTabChange?: (tab: PerpsTerminalBottomTab) => void;
  onCollapse?: () => void;
  hideHeader?: boolean;
}

export function PerpsTerminalBottomPanel({
  ticker,
  activeTab: propActiveTab,
  onTabChange,
  onCollapse,
  hideHeader = false,
}: PerpsTerminalBottomPanelProps) {
  const { user, authenticated } = useAuth();
  const userId = authenticated ? (user?.id ?? null) : null;

  const [internalActiveTab, setInternalActiveTab] =
    useState<PerpsTerminalBottomTab>('positions');
  const activeTab = propActiveTab ?? internalActiveTab;

  const { positions: perpPositions, refresh: refreshUserPositions } =
    usePerpPositions(userId);

  const filteredPositions = useMemo(() => {
    if (!ticker) return [];
    return perpPositions.filter(
      (p) => p.ticker.toLowerCase() === ticker.toLowerCase() && !p.closedAt
    );
  }, [perpPositions, ticker]);

  const containerRef = useRef<HTMLDivElement | null>(null);

  const handlePositionClosed = async () => {
    invalidatePerpMarketsCache();
    invalidateUserPositions();
    invalidateWalletBalance();
    await refreshUserPositions();
  };

  const setActiveTab = (tab: PerpsTerminalBottomTab) => {
    onTabChange?.(tab);
    if (propActiveTab == null) setInternalActiveTab(tab);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!hideHeader && (
        <div className="flex items-center justify-between border-white/5 border-b bg-background/30 px-2">
          <div className="scrollbar-hide flex min-w-0 flex-1 overflow-x-auto">
            <TabButton
              active={activeTab === 'positions'}
              onClick={() => setActiveTab('positions')}
            >
              Positions
              {ticker && (
                <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted/20 px-1.5 text-[10px] tabular-nums">
                  {filteredPositions.length}
                </span>
              )}
            </TabButton>
            <TabButton
              active={activeTab === 'orders'}
              onClick={() => setActiveTab('orders')}
              disabled
              soon
            >
              Orders
            </TabButton>
            <TabButton
              active={activeTab === 'pnl'}
              onClick={() => setActiveTab('pnl')}
              disabled
              soon
            >
              PnL Analysis
            </TabButton>
            <TabButton
              active={activeTab === 'agent'}
              onClick={() => setActiveTab('agent')}
              disabled
              soon
            >
              Agent
            </TabButton>
            <TabButton
              active={activeTab === 'socials'}
              onClick={() => setActiveTab('socials')}
              disabled
              soon
            >
              Social
            </TabButton>
            <TabButton
              active={activeTab === 'trades'}
              onClick={() => setActiveTab('trades')}
            >
              Trades
            </TabButton>
          </div>

          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              className="ml-2 rounded p-2 text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground"
              aria-label="Collapse bottom panel"
            >
              <Minus size={14} />
            </button>
          )}
        </div>
      )}

      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden">
        {!ticker ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            Select a market to see positions and trades.
          </div>
        ) : !authenticated ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            Log in to view your positions.
          </div>
        ) : activeTab === 'positions' ? (
          <div className="h-full overflow-auto">
            {filteredPositions.length > 0 ? (
              <PerpPositionsList
                positions={filteredPositions}
                density="compact"
                onPositionClosed={handlePositionClosed}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
                No open positions
              </div>
            )}
          </div>
        ) : activeTab === 'trades' ? (
          <div className="h-full">
            <AssetTradesFeed
              marketType="perp"
              assetId={ticker}
              containerRef={containerRef}
              density="compact"
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            <div className="flex flex-col items-center gap-2">
              <span className="font-semibold">Coming soon</span>
              <span className="rounded-full bg-muted/20 px-3 py-1 text-[10px] text-muted-foreground uppercase tracking-wider">
                Soon
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
  disabled,
  soon,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  soon?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        '-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-2 font-semibold text-xs transition-colors',
        active
          ? 'border-primary text-primary'
          : 'border-transparent text-muted-foreground hover:text-foreground',
        disabled && 'cursor-not-allowed opacity-60 hover:text-muted-foreground'
      )}
    >
      {children}
      {soon && (
        <span className="rounded-full bg-muted/20 px-2 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wider">
          Soon
        </span>
      )}
    </button>
  );
}
