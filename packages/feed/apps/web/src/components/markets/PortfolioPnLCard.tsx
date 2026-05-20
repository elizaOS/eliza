import type { PortfolioBreakdownSnapshot } from '@babylon/engine/client';
import { Share2, Sparkles } from 'lucide-react';

interface PortfolioPnLCardProps {
  data: PortfolioBreakdownSnapshot | null;
  loading: boolean;
  onShare: () => void;
  onShowBuyPoints: () => void;
}

export function PortfolioPnLCard({
  data,
  loading,
  onShare,
  onShowBuyPoints,
}: PortfolioPnLCardProps) {
  return (
    <div className="flex items-center justify-end gap-3">
      <button
        type="button"
        onClick={onShare}
        disabled={loading || !data}
        className="inline-flex items-center gap-2 rounded-lg bg-white/90 px-3 py-2.5 font-semibold text-[#0B1C3D] text-sm shadow transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Share2 className="h-4 w-4" />
        Share P&amp;L
      </button>
      <button
        type="button"
        onClick={onShowBuyPoints}
        aria-label="Buy Points"
        className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-yellow-500 to-amber-600 px-4 py-2.5 font-medium text-primary-foreground shadow-md transition-all hover:from-yellow-600 hover:to-amber-700 hover:shadow-lg"
      >
        <Sparkles className="h-4 w-4" />
        <span className="hidden sm:inline">Buy Points</span>
      </button>
    </div>
  );
}
