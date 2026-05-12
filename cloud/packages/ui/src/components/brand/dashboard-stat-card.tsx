import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { BrandCard } from "./brand-card";

type DashboardStatAccent = "orange" | "amber" | "blue" | "emerald" | "red" | "violet" | "white";

const accentStyles: Record<DashboardStatAccent, string> = {
  orange: "text-[#FF5800]",
  amber: "text-amber-400",
  blue: "text-blue-400",
  emerald: "text-emerald-400",
  red: "text-red-400",
  violet: "text-violet-400",
  white: "text-white",
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
    <BrandCard className={cn("min-h-[108px] justify-between p-4", className)} corners={false}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <p className="text-[11px] uppercase tracking-[0.24em] text-white/45">{label}</p>
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
              "flex size-10 shrink-0 items-center justify-center border border-current/15 bg-white/[0.03]",
              accentStyles[accent],
            )}
          >
            {icon}
          </div>
        ) : null}
      </div>
      {helper ? <p className="text-xs text-white/40">{helper}</p> : null}
    </BrandCard>
  );
}
