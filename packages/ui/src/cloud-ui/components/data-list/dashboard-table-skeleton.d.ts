import type { ReactNode } from "react";

interface DashboardTableSkeletonColumn {
  key: string;
  label: ReactNode;
  cellClassName?: string;
  skeletonClassName?: string;
}
interface DashboardTableSkeletonProps {
  columns: readonly DashboardTableSkeletonColumn[];
  rows?: number;
  className?: string;
}
export declare function DashboardTableSkeleton({
  columns,
  rows,
  className,
}: DashboardTableSkeletonProps): import("react/jsx-runtime").JSX.Element;
export type { DashboardTableSkeletonColumn, DashboardTableSkeletonProps };
//# sourceMappingURL=dashboard-table-skeleton.d.ts.map
