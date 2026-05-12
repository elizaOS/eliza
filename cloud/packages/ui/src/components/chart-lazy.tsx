/**
 * Lazy-loaded chart wrapper components.
 * Dynamically imports recharts (~400KB) only when needed.
 */

"use client";

import { Loader2 } from "lucide-react";

// Loading skeleton for charts
function _ChartSkeleton({ height = "340px" }: { height?: string }) {
  return (
    <div
      className="flex items-center justify-center rounded-2xl border border-border/70 bg-background/70"
      style={{ height }}
    >
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span className="text-sm">Loading chart...</span>
      </div>
    </div>
  );
}

// Export re-exports from chart.tsx for components that don't need lazy loading
export {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
  ChartTooltip,
  ChartTooltipContent,
} from "./chart";
