import type { ComponentType, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { BrandCard } from "../brand";

interface StatSummaryItem {
  title: string;
  value: ReactNode;
  description?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
}

interface StatSummaryProps {
  items: readonly StatSummaryItem[];
  formatValue?: (value: ReactNode) => ReactNode;
  className?: string;
}

export function StatSummary({
  items,
  formatValue,
  className,
}: StatSummaryProps) {
  return (
    <div
      data-slot="stat-summary"
      className={cn("grid gap-4 sm:grid-cols-2 xl:grid-cols-4", className)}
    >
      {items.map((item) => {
        const Icon = item.icon;

        return (
          <BrandCard key={item.title} corners={false} className="p-4">
            <div className="flex flex-row items-center justify-between space-y-0 pb-2">
              <h4 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                {item.title}
              </h4>
              {Icon ? <Icon className="h-5 w-5 text-accent" /> : null}
            </div>
            <div>
              <div className="mt-2 text-2xl font-semibold text-txt-strong">
                {formatValue ? formatValue(item.value) : item.value}
              </div>
              {item.description ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {item.description}
                </p>
              ) : null}
            </div>
          </BrandCard>
        );
      })}
    </div>
  );
}

export type { StatSummaryItem, StatSummaryProps };
