"use client";

import { cn, formatCompactCurrency } from "@feed/shared";
import { Loader2, TrendingDown, TrendingUp, Users } from "lucide-react";
import { useMemo } from "react";
import type {
  TeamScope,
  TeamTradingSummary,
} from "@/lib/agents/team-trading-summary";
import { ScopeToggle } from "./_components/ScopeToggle";

function pnlChip(value: number) {
  const positive = value >= 0;
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-xs",
        positive
          ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
          : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
      )}
    >
      {positive ? (
        <TrendingUp className="h-3 w-3" />
      ) : (
        <TrendingDown className="h-3 w-3" />
      )}
      {value >= 0 ? "+" : ""}
      {formatCompactCurrency(value)}
    </div>
  );
}

export function TeamPnL({
  summary,
  loading,
  error,
  scope,
  onScopeChange,
  onSelectMember,
}: {
  summary: TeamTradingSummary | null;
  loading: boolean;
  error: string | null;
  scope: TeamScope;
  onScopeChange: (scope: TeamScope) => void;
  onSelectMember?: (id: string, type: "user" | "agent") => void;
}) {
  // Hooks must be called unconditionally (Rules of Hooks)
  const members = useMemo(() => {
    if (!summary) return [];
    return scope === "agents_only"
      ? summary.members.filter((m) => m.entityType === "agent")
      : summary.members;
  }, [summary, scope]);

  // Use pre-computed totals from the hook instead of re-reducing
  const totals = useMemo(() => {
    if (!summary)
      return {
        lifetimePnL: 0,
        unrealizedPnL: 0,
        currentPnL: 0,
        openPositions: 0,
      };
    const src =
      scope === "agents_only" ? summary.agentsOnlyTotals : summary.totals;
    return {
      lifetimePnL: src.lifetimePnL,
      unrealizedPnL: src.unrealizedPnL,
      currentPnL: src.currentPnL,
      openPositions: src.openPositions,
    };
  }, [summary, scope]);

  if (!summary && !loading && !error) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-muted-foreground text-sm">
        Failed to load team P&L: {error}
      </div>
    );
  }

  const currentPositive = totals.currentPnL >= 0;

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-sm">Team P&L</h3>
          <p className="text-muted-foreground text-xs">
            Current P&L = Lifetime P&L + Unrealized P&L (open positions)
          </p>
        </div>
        <ScopeToggle scope={scope} onChange={onScopeChange} />
      </div>

      <div className="space-y-2 rounded-lg border border-border bg-card/50 p-3">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-xs">Current P&L</span>
          {pnlChip(totals.currentPnL)}
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Lifetime P&L</span>
          <span
            className={cn(
              "font-medium",
              totals.lifetimePnL >= 0 ? "text-green-600" : "text-red-600",
            )}
          >
            {totals.lifetimePnL >= 0 ? "+" : ""}
            {formatCompactCurrency(totals.lifetimePnL)}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Unrealized P&L</span>
          <span
            className={cn(
              "font-medium",
              totals.unrealizedPnL >= 0 ? "text-green-600" : "text-red-600",
            )}
          >
            {totals.unrealizedPnL >= 0 ? "+" : ""}
            {formatCompactCurrency(totals.unrealizedPnL)}
          </span>
        </div>
        <div className="border-border border-t pt-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Open Positions</span>
            <span className="font-medium">{totals.openPositions}</span>
          </div>
        </div>
        <div className="pt-1 text-[11px] text-muted-foreground">
          {currentPositive
            ? "Team is currently profitable."
            : "Team is currently down."}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-muted/20 p-3">
        <div className="mb-2 flex items-center gap-2 text-muted-foreground text-xs">
          <Users className="h-4 w-4" />
          Per-member breakdown
        </div>

        <div className="space-y-1">
          {members.map((m) => {
            const label = m.entityType === "owner" ? "Owner" : "Agent";
            const name = m.name || (m.entityType === "owner" ? "You" : "Agent");

            return (
              <button
                key={`${m.entityType}-${m.id}`}
                type="button"
                onClick={() => {
                  if (!onSelectMember) return;
                  onSelectMember(
                    m.id,
                    m.entityType === "owner" ? "user" : "agent",
                  );
                }}
                className={cn(
                  "flex w-full items-start justify-between gap-3 rounded-md px-2 py-2 text-left transition-colors",
                  onSelectMember ? "hover:bg-muted/40" : "cursor-default",
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-sm">{name}</span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase">
                      {label}
                    </span>
                  </div>
                  {m.username && (
                    <div className="truncate text-muted-foreground text-xs">
                      @{m.username}
                    </div>
                  )}
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {m.openPositions} open position
                    {m.openPositions === 1 ? "" : "s"}
                  </div>
                </div>

                <div className="shrink-0 text-right">
                  <div className="font-medium text-sm">
                    {m.currentPnL >= 0 ? "+" : ""}
                    {formatCompactCurrency(m.currentPnL)}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    L: {m.lifetimePnL >= 0 ? "+" : ""}
                    {formatCompactCurrency(m.lifetimePnL)}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    U: {m.unrealizedPnL >= 0 ? "+" : ""}
                    {formatCompactCurrency(m.unrealizedPnL)}
                  </div>
                </div>
              </button>
            );
          })}

          {members.length === 0 && (
            <div className="py-3 text-center text-muted-foreground text-xs">
              No members found.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
