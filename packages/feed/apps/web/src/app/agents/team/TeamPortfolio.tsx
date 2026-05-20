"use client";

import { cn, formatCompactCurrency } from "@feed/shared";
import { Loader2, Users, Wallet } from "lucide-react";
import { useMemo } from "react";
import type {
  TeamScope,
  TeamTradingSummary,
} from "@/lib/agents/team-trading-summary";
import { ScopeToggle } from "./_components/ScopeToggle";

export function TeamPortfolio({
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

  const totalWallet = useMemo(() => {
    if (!summary) return 0;
    return scope === "agents_only"
      ? summary.agentsOnlyTotals.walletBalance
      : summary.totals.walletBalance;
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
        Failed to load team wallet: {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-sm">Team Wallet</h3>
          <p className="text-muted-foreground text-xs">
            Aggregated trading balance across your team
          </p>
        </div>
        <ScopeToggle scope={scope} onChange={onScopeChange} />
      </div>

      <div className="rounded-lg border border-border bg-card/50 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <Wallet className="h-4 w-4" />
            Total Wallet Balance
          </div>
          <div className="font-semibold text-sm">
            {formatCompactCurrency(totalWallet)}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-muted/20 p-3">
        <div className="mb-2 flex items-center gap-2 text-muted-foreground text-xs">
          <Users className="h-4 w-4" />
          Breakdown
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
                  "flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left transition-colors",
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
                </div>
                <div className="shrink-0 font-medium text-sm">
                  {formatCompactCurrency(m.walletBalance)}
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
