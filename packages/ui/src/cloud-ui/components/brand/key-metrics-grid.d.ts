import type { LucideIcon } from "lucide-react";
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
export declare function KeyMetricsGrid({
  metrics,
  columns,
}: KeyMetricsGridProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=key-metrics-grid.d.ts.map
