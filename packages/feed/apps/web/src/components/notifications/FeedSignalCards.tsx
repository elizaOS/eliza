"use client";

import { cn, FEED_POINTS_SYMBOL } from "@feed/shared";
import { ChevronRight } from "lucide-react";
import Link from "next/link";

/* ─── Shared ─────────────────────────────────────────────── */

interface SignalCardShellProps {
  accent: "amber" | "green" | "red";
  href: string;
  children: React.ReactNode;
}

const accentMap = {
  amber: {
    hover: "hover:bg-muted/30",
    label: "text-amber-500",
  },
  green: {
    hover: "hover:bg-green-500/5",
    label: "text-green-500",
  },
  red: {
    hover: "hover:bg-red-500/5",
    label: "text-red-500",
  },
};

/** Consistent shell for all feed signal cards — entire card is tappable */
function SignalCardShell({ accent, href, children }: SignalCardShellProps) {
  const a = accentMap[accent];

  return (
    <Link
      href={href}
      className={cn(
        "group flex items-center justify-between gap-3 border-border border-b px-4 py-3 transition-colors",
        a.hover,
      )}
    >
      <div className="min-w-0 flex-1">{children}</div>

      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5" />
    </Link>
  );
}

/* ─── 4a. Market Closing Soon Card ───────────────────────── */

export interface MarketClosingSoonProps {
  marketId: string;
  marketName: string;
  closesAt: string;
  positionSide: "YES" | "NO" | "long" | "short";
  currentPrice: number;
  entryPrice: number;
}

function formatTimeLeft(isoDate: string): string {
  const ms = new Date(isoDate).getTime() - Date.now();
  if (ms <= 0) return "Closing now";
  const totalMinutes = Math.floor(ms / (1000 * 60));
  if (totalMinutes < 60) return `${totalMinutes}m left`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return `${hours}h ${minutes}m left`;
  return `${Math.floor(hours / 24)}d left`;
}

export function MarketClosingSoonCard({
  marketId,
  marketName,
  closesAt,
  positionSide,
  currentPrice,
  entryPrice,
}: MarketClosingSoonProps) {
  const timeLeft = formatTimeLeft(closesAt);
  const pnlPercent =
    entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
  const isPositive = pnlPercent >= 0;

  return (
    <SignalCardShell
      accent="amber"
      href={`/markets/predictions/${encodeURIComponent(marketId)}`}
    >
      <p className="font-semibold text-foreground text-sm leading-snug">
        {marketName}
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-medium text-xs",
            positionSide === "YES" || positionSide === "long"
              ? "bg-green-500/10 text-green-500"
              : "bg-red-500/10 text-red-500",
          )}
        >
          {positionSide}
        </span>
        <span className="text-muted-foreground text-xs">
          @ {FEED_POINTS_SYMBOL}
          {entryPrice.toFixed(2)}
        </span>
        <span className="font-medium text-foreground text-xs">
          {isPositive ? "+" : ""}
          {pnlPercent.toFixed(1)}%
        </span>
        <span className="font-medium text-amber-500 text-xs">{timeLeft}</span>
      </div>
    </SignalCardShell>
  );
}

/* ─── 4b. Top Gainer of the Day Card ─────────────────────── */

export interface TopGainerProps {
  marketId: string;
  marketName: string;
  pointsGained: number;
  gainPercent: number;
  agentName?: string;
}

export function TopGainerCard({
  marketId,
  marketName,
  pointsGained,
  gainPercent,
  agentName,
}: TopGainerProps) {
  return (
    <SignalCardShell
      accent="green"
      href={`/markets/predictions/${encodeURIComponent(marketId)}`}
    >
      <p className="font-semibold text-foreground text-sm leading-snug">
        {marketName}
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="font-bold text-green-500 text-sm">
          +{pointsGained.toLocaleString("en-US")} pts
        </span>
        <span className="font-medium text-green-500 text-xs">
          +{gainPercent.toFixed(1)}%
        </span>
        {agentName && (
          <span className="text-muted-foreground text-xs">
            via <span className="font-medium text-foreground">{agentName}</span>
          </span>
        )}
      </div>
    </SignalCardShell>
  );
}

/* ─── 4c. Top Loser of the Day Card ──────────────────────── */

export interface TopLoserProps {
  marketId: string;
  marketName: string;
  pointsLost: number;
  lossPercent: number;
  agentName?: string;
}

export function TopLoserCard({
  marketId,
  marketName,
  pointsLost,
  lossPercent,
  agentName,
}: TopLoserProps) {
  return (
    <SignalCardShell
      accent="red"
      href={`/markets/predictions/${encodeURIComponent(marketId)}`}
    >
      <p className="font-semibold text-foreground text-sm leading-snug">
        {marketName}
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="font-bold text-red-500 text-sm">
          {pointsLost.toLocaleString("en-US")} pts
        </span>
        <span className="font-medium text-red-500 text-xs">
          {lossPercent.toFixed(1)}%
        </span>
        {agentName && (
          <span className="text-muted-foreground text-xs">
            via <span className="font-medium text-foreground">{agentName}</span>
          </span>
        )}
      </div>
    </SignalCardShell>
  );
}
