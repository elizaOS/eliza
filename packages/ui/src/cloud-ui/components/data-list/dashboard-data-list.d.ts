import type { ReactNode } from "react";

interface DashboardDataListProps {
  children: ReactNode;
  className?: string;
}
export declare function DashboardDataList({
  children,
  className,
}: DashboardDataListProps): import("react/jsx-runtime").JSX.Element;
interface DashboardDataListMobileProps {
  children: ReactNode;
  className?: string;
}
export declare function DashboardDataListMobile({
  children,
  className,
}: DashboardDataListMobileProps): import("react/jsx-runtime").JSX.Element;
interface DashboardDataListDesktopProps {
  children: ReactNode;
  className?: string;
}
export declare function DashboardDataListDesktop({
  children,
  className,
}: DashboardDataListDesktopProps): import("react/jsx-runtime").JSX.Element;
interface DashboardDataListCardProps {
  children: ReactNode;
  className?: string;
}
export declare function DashboardDataListCard({
  children,
  className,
}: DashboardDataListCardProps): import("react/jsx-runtime").JSX.Element;
interface DashboardDataListFilteredCountProps {
  filtered: number;
  total: number;
  label: string;
  className?: string;
}
export declare function DashboardDataListFilteredCount({
  filtered,
  total,
  label,
  className,
}: DashboardDataListFilteredCountProps): import("react/jsx-runtime").JSX.Element;
export type {
  DashboardDataListCardProps,
  DashboardDataListDesktopProps,
  DashboardDataListFilteredCountProps,
  DashboardDataListMobileProps,
  DashboardDataListProps,
};
//# sourceMappingURL=dashboard-data-list.d.ts.map
