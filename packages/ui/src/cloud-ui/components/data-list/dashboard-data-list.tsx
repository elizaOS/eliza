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
      // Show at md+, hide below — via `max-md:hidden` (a max-width query) plus
      // the div's default block display, NOT `hidden md:block`. The console
      // bundle concatenates two independent Tailwind builds (the app's
      // `@elizaos/ui/styles` and cloud-ui's own `@import "tailwindcss"`), so a
      // second base `.hidden{display:none}` is emitted AFTER the responsive
      // `.md:block` — same specificity, later wins — which pinned every
      // `hidden md:block` desktop table to display:none at all widths (the real
      // cause of the "banner shows N but the table is empty" bug). Avoiding the
      // `hidden` base class sidesteps that clobber; root dedupe tracked
      // separately.
      className={cn(
        "overflow-hidden border border-white/10 max-md:hidden",
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
