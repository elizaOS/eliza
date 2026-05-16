import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { BrandCard } from "./brand-card";

type DashboardStatAccent =
  | "orange"
  | "amber"
  | "blue"
  | "emerald"
  | "red"
  | "violet"
  | "white";

const accentStyles: Record<DashboardStatAccent, string> = {
  orange: "text-accent",
  amber: "text-warn",
  blue: "text-status-info",
  emerald: "text-ok",
  red: "text-danger",
  violet: "text-status-info",
  white: "text-txt-strong",
};

interface DashboardStatCardProps {
  label: string;
  value: string | number;
  icon?: ReactNode;
  helper?: string;
  accent?: DashboardStatAccent;
  className?: string;
  valueClassName?: string;
}

export function DashboardStatCard({
  label,
  value,
  icon,
  helper,
  accent = "white",
  className,
  valueClassName,
}: DashboardStatCardProps) {
  return (
    <BrandCard
      className={cn("min-h-[108px] justify-between p-4", className)}
      corners={false}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <p className="text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
            {label}
          </p>
          <p
            className={cn(
              "break-words text-xl font-semibold leading-tight md:text-2xl",
              accentStyles[accent],
              valueClassName,
            )}
          >
            {value}
          </p>
        </div>
        {icon ? (
          <div
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-sm border border-current/15 bg-bg-elevated",
              accentStyles[accent],
            )}
          >
            {icon}
          </div>
        ) : null}
      </div>
      {helper ? (
        <p className="text-xs text-muted-foreground">{helper}</p>
      ) : null}
    </BrandCard>
  );
}
