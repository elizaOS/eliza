"use client";

import { cn, formatCurrency } from "@feed/shared";
import { ChevronDown } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useOnClickOutside } from "@/hooks/useOnClickOutside";
import type { TeamTradingSummary } from "@/lib/agents/team-trading-summary";
import type { PnlHistoryScope } from "@/lib/wallet/pnl-history-types";
import { PnLChart } from "./pnl-chart";

interface PnLTabProps {
  userId: string;
  teamSummary: TeamTradingSummary | null;
  teamSummaryLoading: boolean;
  teamSummaryError: string | null;
}

interface EntityPnL {
  entityId: string | null;
  name: string;
  currentPnl: number;
  lifetimePnl: number;
  scope: PnlHistoryScope;
  unrealized: number;
  isSelected?: boolean;
}

const timeFilters = ["1H", "4H", "1D", "1W", "ALL"];

function getEntitySelectionKey(entity: {
  entityId: string | null;
  scope: PnlHistoryScope;
}): string {
  switch (entity.scope) {
    case "team":
      return "team";
    case "owner":
      return "owner";
    case "agent":
      return `agent:${entity.entityId}`;
  }
}

export function PnLTab({
  userId,
  teamSummary,
  teamSummaryLoading,
  teamSummaryError,
}: PnLTabProps) {
  const [selectedTime, setSelectedTime] = useState("1D");
  const [selectedEntityKey, setSelectedEntityKey] = useState("team");
  const [entityDropdownOpen, setEntityDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const loading = teamSummaryLoading;

  const entities = useMemo(() => {
    if (!teamSummary) {
      return [] as EntityPnL[];
    }

    const list: EntityPnL[] = [
      {
        entityId: null,
        name: "Team",
        currentPnl: teamSummary.totals.currentPnL,
        lifetimePnl: teamSummary.totals.lifetimePnL,
        scope: "team",
        unrealized: teamSummary.totals.unrealizedPnL,
        isSelected: selectedEntityKey === "team",
      },
    ];

    for (const member of teamSummary.members) {
      const name = member.entityType === "owner" ? "You" : member.name;
      const scope = member.entityType === "owner" ? "owner" : "agent";

      list.push({
        entityId: member.id,
        name,
        currentPnl: member.currentPnL,
        lifetimePnl: member.lifetimePnL,
        scope,
        unrealized: member.unrealizedPnL,
        isSelected:
          selectedEntityKey ===
          getEntitySelectionKey({ entityId: member.id, scope }),
      });
    }

    return list;
  }, [selectedEntityKey, teamSummary]);

  useOnClickOutside(dropdownRef, () => {
    setEntityDropdownOpen(false);
  });

  const handleEntitySelect = useCallback((entity: EntityPnL) => {
    setSelectedEntityKey(getEntitySelectionKey(entity));
    setEntityDropdownOpen(false);
  }, []);

  const fmtPnl = (value: number) => {
    const sign = value >= 0 ? "+" : "-";
    return `${sign}${formatCurrency(Math.abs(value), { useThousandsSeparator: true })}`;
  };

  if (loading) {
    return (
      <div className="space-y-3 md:space-y-4">
        <div className="h-8 w-32 animate-pulse rounded bg-muted" />
        <div className="h-[200px] animate-pulse rounded-xl bg-muted" />
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  if (!teamSummary && teamSummaryError) {
    return (
      <div className="rounded-xl border border-border py-10 text-center">
        <p className="text-muted-foreground">Failed to load team P&L</p>
        <p className="mt-1 text-muted-foreground text-sm">{teamSummaryError}</p>
      </div>
    );
  }

  // Find selected entity for the hero display
  const selected = entities.find((e) => e.isSelected) ?? entities[0];

  const selectedEntityName = selected?.name ?? "Team";

  return (
    <div className="space-y-3 md:space-y-5">
      {/* Header: entity selector + time filters */}
      <div className="flex items-center justify-between">
        <div className="relative" ref={dropdownRef}>
          <button
            className="flex items-center gap-1.5 font-semibold text-base"
            onClick={() => setEntityDropdownOpen((prev) => !prev)}
          >
            {selectedEntityName}
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          {entityDropdownOpen && (
            <div className="absolute top-full left-0 z-50 mt-1 min-w-[140px] overflow-hidden rounded-lg border border-border bg-background shadow-lg">
              {entities.map((entity) => (
                <button
                  key={`${entity.scope}:${entity.entityId ?? "team"}`}
                  onClick={() => handleEntitySelect(entity)}
                  className={cn(
                    "w-full px-3 py-2 text-left text-sm transition-colors",
                    entity.isSelected
                      ? "bg-muted font-medium"
                      : "hover:bg-muted/50",
                  )}
                >
                  {entity.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {timeFilters.map((time) => (
            <button
              key={time}
              onClick={() => setSelectedTime(time)}
              className={`rounded-md px-2.5 py-1 font-medium text-xs transition-colors ${
                selectedTime === time
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {time}
            </button>
          ))}
        </div>
      </div>

      {/* Selected entity P&L summary */}
      {selected && (
        <div className="grid grid-cols-1 gap-1.5 md:grid-cols-3 md:gap-3">
          <div className="rounded-xl border border-border px-3 py-2.5 md:p-4">
            <div className="mb-1 text-muted-foreground text-xs tracking-wide">
              Current
            </div>
            <div
              className={cn(
                "font-semibold text-sm md:text-base",
                selected.currentPnl >= 0 ? "text-emerald-500" : "text-red-500",
              )}
            >
              {fmtPnl(selected.currentPnl)}
            </div>
          </div>
          <div className="rounded-xl border border-border px-3 py-2.5 md:p-4">
            <div className="mb-1 text-muted-foreground text-xs tracking-wide">
              Lifetime
            </div>
            <div
              className={cn(
                "font-semibold text-sm md:text-base",
                selected.lifetimePnl >= 0 ? "text-emerald-500" : "text-red-500",
              )}
            >
              {fmtPnl(selected.lifetimePnl)}
            </div>
          </div>
          <div className="rounded-xl border border-border px-3 py-2.5 md:p-4">
            <div className="mb-1 text-muted-foreground text-xs tracking-wide">
              Unrealized
            </div>
            <div
              className={cn(
                "font-semibold text-sm md:text-base",
                selected.unrealized >= 0 ? "text-emerald-500" : "text-red-500",
              )}
            >
              {fmtPnl(selected.unrealized)}
            </div>
          </div>
        </div>
      )}

      {/* Chart */}
      <div className="rounded-xl border border-border p-2 md:p-3">
        <PnLChart
          entityId={selected?.scope === "agent" ? selected.entityId : null}
          metricLabel="Current P&L"
          scope={selected?.scope ?? "team"}
          userId={userId}
          timeframe={selectedTime}
        />
      </div>
    </div>
  );
}
