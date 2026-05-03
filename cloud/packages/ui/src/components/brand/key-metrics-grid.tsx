import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { BrandCard } from "./brand-card";

export interface KeyMetric {
  label: string;
  value: string;
  helper?: string;
  delta?: {
    value: string;
    trend?: "up" | "down" | "neutral";
    label?: string;
  };
  icon: LucideIcon;
  accent?: "violet" | "sky" | "emerald" | "amber" | "rose";
}

interface KeyMetricsGridProps {
  metrics: KeyMetric[];
  columns?: 2 | 3 | 4;
}

const accentClasses: Record<NonNullable<KeyMetric["accent"]>, string> = {
  violet: "border-violet-500/40",
  sky: "border-sky-500/40",
  emerald: "border-emerald-500/40",
  amber: "border-amber-500/40",
  rose: "border-rose-500/40",
};

type TrendTone = "up" | "down" | "neutral";

const deltaToneClasses: Record<TrendTone, string> = {
  up: "bg-emerald-500/20 text-emerald-400 border-emerald-500/40",
  down: "bg-rose-500/20 text-rose-400 border-rose-500/40",
  neutral: "bg-white/10 text-white/60 border-white/20",
};

export function KeyMetricsGrid({ metrics, columns = 4 }: KeyMetricsGridProps) {
  return (
    <div
      className={cn("grid gap-5 sm:gap-6", {
        "md:grid-cols-2 xl:grid-cols-4": columns === 4,
        "md:grid-cols-2 xl:grid-cols-3": columns === 3,
        "md:grid-cols-2": columns === 2,
      })}
    >
      {metrics.map((metric) => {
        const tone: TrendTone = metric.delta?.trend ?? "neutral";

        return (
          <BrandCard
            key={metric.label}
            corners={false}
            className={cn(
              "relative overflow-hidden transition-colors hover:border-[#FF5800]/40",
              metric.accent ? accentClasses[metric.accent] : "",
            )}
          >
            <div className="absolute right-5 top-5 text-white/30">
              <metric.icon className="h-5 w-5" />
            </div>
            <div className="space-y-2 p-6 pb-4">
              <h4 className="text-xs font-medium uppercase tracking-wide text-white/50">
                {metric.label}
              </h4>
            </div>
            <div className="flex flex-col gap-4 p-6 pt-3">
              <div className="break-words text-2xl font-semibold leading-tight text-white md:text-3xl">
                {metric.value}
              </div>
              {metric.delta ? (
                <span
                  className={cn(
                    "w-fit rounded-none border px-2 py-1 text-xs font-bold uppercase tracking-wide",
                    deltaToneClasses[tone],
                  )}
                >
                  {metric.delta.value}
                  {metric.delta.label ? ` · ${metric.delta.label}` : null}
                </span>
              ) : null}
              {metric.helper ? <p className="text-sm text-white/60">{metric.helper}</p> : null}
            </div>
          </BrandCard>
        );
      })}
    </div>
  );
}
