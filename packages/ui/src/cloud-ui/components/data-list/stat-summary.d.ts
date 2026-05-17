import type { ComponentType, ReactNode } from "react";

interface StatSummaryItem {
  title: string;
  value: ReactNode;
  description?: ReactNode;
  icon?: ComponentType<{
    className?: string;
  }>;
}
interface StatSummaryProps {
  items: readonly StatSummaryItem[];
  formatValue?: (value: ReactNode) => ReactNode;
  className?: string;
}
export declare function StatSummary({
  items,
  formatValue,
  className,
}: StatSummaryProps): import("react/jsx-runtime").JSX.Element;
export type { StatSummaryItem, StatSummaryProps };
//# sourceMappingURL=stat-summary.d.ts.map
