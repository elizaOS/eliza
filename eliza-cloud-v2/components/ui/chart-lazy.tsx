/**
 * Lazy-loaded chart wrapper components.
 * Dynamically imports recharts (~400KB) only when needed.
 */

"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

// Loading skeleton for charts
function ChartSkeleton({ height = "340px" }: { height?: string }) {
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
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
  type ChartConfig,
} from "./chart";

// Lazy-loaded UsageChart
export const UsageChartLazy = dynamic(
  () =>
    import("@/components/analytics/usage-chart").then((mod) => mod.UsageChart),
  {
    ssr: false,
    loading: () => <ChartSkeleton />,
  },
);

// Lazy-loaded ProjectionsChart
export const ProjectionsChartLazy = dynamic(
  () =>
    import("@/components/analytics/projections-chart").then(
      (mod) => mod.ProjectionsChart,
    ),
  {
    ssr: false,
    loading: () => <ChartSkeleton />,
  },
);
