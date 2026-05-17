import type { ReactNode } from "react";

type DashboardStatAccent =
  | "orange"
  | "amber"
  | "blue"
  | "emerald"
  | "red"
  | "violet"
  | "white";
interface DashboardStatCardProps {
  label: string;
  value: string | number;
  icon?: ReactNode;
  helper?: string;
  accent?: DashboardStatAccent;
  className?: string;
  valueClassName?: string;
}
export declare function DashboardStatCard({
  label,
  value,
  icon,
  helper,
  accent,
  className,
  valueClassName,
}: DashboardStatCardProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=dashboard-stat-card.d.ts.map
