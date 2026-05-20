'use client';

import { cn, formatCurrency } from '@babylon/shared';
import type { MarketTab } from '@/types/markets';

// Re-export for backwards compatibility
export type { MarketTab } from '@/types/markets';

const TABS: { id: MarketTab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'perps', label: 'Perps' },
  { id: 'predictions', label: 'Predictions' },
];

interface MarketsToggleProps {
  activeTab: MarketTab;
  onTabChange: (tab: MarketTab) => void;
  balance?: number | null;
  authenticated?: boolean;
  loading?: boolean;
}

export function MarketsToggle({
  activeTab,
  onTabChange,
  balance,
  authenticated,
  loading,
}: MarketsToggleProps) {
  return (
    <div className="flex w-full items-center border-border border-b">
      <div className="flex flex-1">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => onTabChange(id)}
            className={cn(
              'relative flex-1 py-3.5 font-semibold transition-all hover:bg-muted/20',
              activeTab === id ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            {label}
            {activeTab === id && (
              <div className="absolute right-0 bottom-0 left-0 h-[3px] bg-primary" />
            )}
          </button>
        ))}
      </div>
      {authenticated && (
        <div className="flex shrink-0 items-center px-4">
          {loading ? (
            <div className="h-5 w-16 animate-pulse rounded bg-muted" />
          ) : balance != null ? (
            <span className="font-semibold text-foreground">
              {formatCurrency(balance, { useThousandsSeparator: true })}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
