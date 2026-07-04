/**
 * Generic dashboard data-list container + card primitives for list surfaces.
 */
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface DashboardDataListProps {
  children: ReactNode;
  className?: string;
}

export function DashboardDataList({
  children,
  className,
}: DashboardDataListProps) {
  return (
    <div data-slot="dashboard-data-list" className={cn("space-y-4", className)}>
      {children}
    </div>
  );
}

interface DashboardDataListMobileProps {
  children: ReactNode;
  className?: string;
}

export function DashboardDataListMobile({
  children,
  className,
}: DashboardDataListMobileProps) {
  return (
    <div
      data-slot="dashboard-data-list-mobile"
      className={cn("space-y-2 md:hidden", className)}
    >
      {children}
    </div>
  );
}

interface DashboardDataListDesktopProps {
  children: ReactNode;
  className?: string;
}

export function DashboardDataListDesktop({
  children,
  className,
}: DashboardDataListDesktopProps) {
  return (
    <div
      data-slot="dashboard-data-list-desktop"
      className={cn(
        "hidden overflow-hidden border border-white/10 md:block",
        className,
      )}
    >
      {children}
    </div>
  );
}

interface DashboardDataListCardProps {
  children: ReactNode;
  className?: string;
}

export function DashboardDataListCard({
  children,
  className,
}: DashboardDataListCardProps) {
  return (
    <div
      data-slot="dashboard-data-list-card"
      className={cn("border border-white/10 bg-black/40 p-4", className)}
    >
      {children}
    </div>
  );
}

interface DashboardDataListFilteredCountProps {
  filtered: number;
  total: number;
  label: string;
  className?: string;
}

export function DashboardDataListFilteredCount({
  filtered,
  total,
  label,
  className,
}: DashboardDataListFilteredCountProps) {
  return (
    <p
      data-slot="dashboard-data-list-filtered-count"
      className={cn(
        "text-[11px] uppercase tracking-widest text-white/40 tabular-nums",
        className,
      )}
    >
      {filtered} of {total} {label}
    </p>
  );
}

export type {
  DashboardDataListCardProps,
  DashboardDataListDesktopProps,
  DashboardDataListFilteredCountProps,
  DashboardDataListMobileProps,
  DashboardDataListProps,
};
