"use client";

import type { LeaderboardMetric, LeaderboardScope } from "@feed/shared";
import { cn } from "@feed/shared";

interface LeaderboardToggleProps {
  activeMetric: LeaderboardMetric;
  activeScope: LeaderboardScope;
  onMetricChange: (metric: LeaderboardMetric) => void;
  onScopeChange: (scope: LeaderboardScope) => void;
}

export function LeaderboardToggle({
  activeMetric,
  activeScope,
  onMetricChange,
  onScopeChange,
}: LeaderboardToggleProps) {
  const metricOptions: Array<{
    label: string;
    value: LeaderboardMetric;
  }> = [
    { label: "Reputation", value: "reputation" },
    { label: "Trading Return", value: "trading" },
  ];

  const scopeOptions: Array<{
    label: string;
    value: LeaderboardScope;
  }> = [
    { label: "Per Wallet", value: "wallet" },
    { label: "Team", value: "team" },
  ];

  const renderOption = <T extends string>({
    activeValue,
    onChange,
    options,
  }: {
    activeValue: T;
    onChange: (value: T) => void;
    options: Array<{ label: string; value: T }>;
  }) => (
    <div className="flex w-full items-center border-border border-b last:border-b-0">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "relative flex-1 py-3 font-semibold transition-all hover:bg-muted/20",
            activeValue === option.value
              ? "text-foreground"
              : "text-muted-foreground",
          )}
        >
          {option.label}
          {activeValue === option.value && (
            <div className="absolute right-0 bottom-0 left-0 h-[3px] bg-primary" />
          )}
        </button>
      ))}
    </div>
  );

  return (
    <div className="w-full border-border border-b">
      {renderOption({
        activeValue: activeMetric,
        onChange: onMetricChange,
        options: metricOptions,
      })}
      {renderOption({
        activeValue: activeScope,
        onChange: onScopeChange,
        options: scopeOptions,
      })}
    </div>
  );
}
