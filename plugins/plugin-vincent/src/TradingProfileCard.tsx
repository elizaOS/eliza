/** TradingProfileCard — P&L summary stats and per-token breakdown. */

import { BadgeDollarSign, Repeat2, Target, TrendingUp } from "lucide-react";
import type { ComponentType } from "react";
import type { VincentTradingProfile } from "./vincent-contracts";

interface TradingProfileCardProps {
  tradingProfile: VincentTradingProfile | null;
}

interface StatTileProps {
  label: string;
  value: string;
  tone?: "accent" | "ok" | "muted";
  icon: ComponentType<{ className?: string }>;
}

function StatTile({ label, value, tone = "muted", icon: Icon }: StatTileProps) {
  const toneClass =
    tone === "ok"
      ? "text-ok"
      : tone === "accent"
        ? "text-accent"
        : "text-muted";

  return (
    <div className="px-1 py-1">
      <Icon className={`h-4 w-4 ${toneClass}`} />
      <div className="mt-2 text-sm font-semibold tabular-nums text-txt">
        {value}
      </div>
      <div className="mt-0.5 text-2xs font-semibold text-muted">{label}</div>
    </div>
  );
}

function formatWinRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function TradingProfileCard({
  tradingProfile,
}: TradingProfileCardProps) {
  if (!tradingProfile) {
    return (
      <div className="rounded-2xl border border-border/18 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <TrendingUp className="h-4 w-4 text-muted/50" />
          <span
            className="h-2 w-2 rounded-full bg-muted/50"
            title="No analytics"
          />
        </div>
      </div>
    );
  }

  const { totalPnl, winRate, totalSwaps, volume24h, tokenBreakdown } =
    tradingProfile;

  return (
    <div className="space-y-3 rounded-2xl border border-border/18 px-4 py-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-accent" />
        <span className="text-sm font-semibold text-txt">P&amp;L</span>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <StatTile
          icon={BadgeDollarSign}
          label="P&L"
          value={totalPnl}
          tone="ok"
        />
        <StatTile
          icon={Target}
          label="Win"
          value={formatWinRate(winRate)}
          tone="accent"
        />
        <StatTile icon={Repeat2} label="Swaps" value={String(totalSwaps)} />
        <StatTile icon={TrendingUp} label="24h" value={volume24h} />
      </div>

      {tokenBreakdown && tokenBreakdown.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tokenBreakdown.slice(0, 8).map((tok) => (
            <span
              key={tok.symbol}
              className="inline-flex items-center gap-2 rounded-full border border-border/25 bg-card/55 px-3 py-1.5 text-xs font-semibold text-muted"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-ok" />
              <span className="text-txt">{tok.symbol}</span>
              <span className="font-mono text-ok">{tok.pnl}</span>
              <span className="font-mono">{tok.swaps}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
