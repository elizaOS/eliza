import type { HTMLAttributes, ReactNode } from "react";

type DashboardContainerElement = "div" | "main" | "section";
type DashboardContainerWidth = "wide" | "narrow" | "full";
type DashboardGridColumns = 2 | 3 | 4;
interface DashboardPageContainerProps extends HTMLAttributes<HTMLElement> {
  as?: DashboardContainerElement;
  width?: DashboardContainerWidth;
  children: ReactNode;
}
export declare function DashboardPageContainer({
  as: Component,
  width,
  className,
  children,
  ...props
}: DashboardPageContainerProps): import("react/jsx-runtime").JSX.Element;
interface DashboardPageStackProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}
export declare function DashboardPageStack({
  className,
  children,
  ...props
}: DashboardPageStackProps): import("react/jsx-runtime").JSX.Element;
interface DashboardToolbarProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}
export declare function DashboardToolbar({
  className,
  children,
  ...props
}: DashboardToolbarProps): import("react/jsx-runtime").JSX.Element;
interface DashboardStatGridProps extends HTMLAttributes<HTMLDivElement> {
  columns?: DashboardGridColumns;
  children: ReactNode;
}
export declare function DashboardStatGrid({
  columns,
  className,
  children,
  ...props
}: DashboardStatGridProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=dashboard-page.d.ts.map
