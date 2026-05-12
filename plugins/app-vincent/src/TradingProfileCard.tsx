/**
 * TradingProfileCard — displays P&L summary stats and per-token breakdown.
 *
 * Renders P&L only when Vincent provides analytics.
 */

import { TrendingUp } from "lucide-react";
import type { VincentTradingProfile } from "./vincent-contracts";

interface TradingProfileCardProps {
  tradingProfile: VincentTradingProfile | null;
}

interface StatRowProps {
  label: string;
  value: string;
  accent?: boolean;
}

function StatRow({ label, value, accent = false }: StatRowProps) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-border/10 last:border-0">
      <span className="text-xs text-muted">{label}</span>
      <span
        className={`text-sm font-semibold tabular-nums ${accent ? "text-ok" : "text-txt"}`}
      >
        {value}
      </span>
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
      <div className="rounded-3xl border border-border/18 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_98%,transparent))] px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted/50" />
          <span className="text-sm text-muted">
            Vincent trading analytics are not available from Vincent yet.
          </span>
        </div>
      </div>
    );
  }

  const { totalPnl, winRate, totalSwaps, volume24h, tokenBreakdown } =
    tradingProfile;

  return (
    <div className="rounded-3xl border border-border/18 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_98%,transparent))] px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-accent" />
        <span className="text-sm font-semibold text-txt">Trading Profile</span>
      </div>

      {/* Summary stats */}
      <div className="rounded-xl border border-border/20 bg-card/40 px-4 divide-y divide-border/10">
        <StatRow label="Total P&amp;L" value={totalPnl} accent />
        <StatRow label="Win Rate" value={formatWinRate(winRate)} />
        <StatRow label="Total Swaps" value={String(totalSwaps)} />
        <StatRow label="24h Volume" value={volume24h} />
      </div>

      {/* Token breakdown */}
      {tokenBreakdown && tokenBreakdown.length > 0 && (
        <div className="rounded-xl border border-border/20 bg-card/40 overflow-hidden">
          <div className="border-b border-border/20 px-4 py-2.5">
            <span className="text-xs-tight font-semibold uppercase tracking-wider text-muted/70">
              Token Breakdown
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-wider text-muted/70">
                  <th className="px-4 py-2.5">Token</th>
                  <th className="px-4 py-2.5 text-right">P&amp;L</th>
                  <th className="px-4 py-2.5 text-right">Swaps</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/10">
                {tokenBreakdown.map((tok) => (
                  <tr
                    key={tok.symbol}
                    className="transition-colors hover:bg-accent/4"
                  >
                    <td className="px-4 py-2.5 text-xs font-medium text-txt">
                      {tok.symbol}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-ok">
                      {tok.pnl}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs tabular-nums text-muted">
                      {tok.swaps}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
