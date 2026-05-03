import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

type DashboardContainerElement = "div" | "main" | "section";
type DashboardContainerWidth = "wide" | "narrow" | "full";
type DashboardGridColumns = 2 | 3 | 4;

interface DashboardPageContainerProps extends HTMLAttributes<HTMLElement> {
  as?: DashboardContainerElement;
  width?: DashboardContainerWidth;
  children: ReactNode;
}

const containerWidths: Record<DashboardContainerWidth, string> = {
  wide: "mx-auto w-full max-w-[1400px]",
  narrow: "mx-auto w-full max-w-5xl",
  full: "w-full",
};

export function DashboardPageContainer({
  as: Component = "div",
  width = "wide",
  className,
  children,
  ...props
}: DashboardPageContainerProps) {
  return (
    <Component className={cn("min-w-0", containerWidths[width], className)} {...props}>
      {children}
    </Component>
  );
}

interface DashboardPageStackProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function DashboardPageStack({ className, children, ...props }: DashboardPageStackProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-6 md:gap-8", className)} {...props}>
      {children}
    </div>
  );
}

interface DashboardToolbarProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function DashboardToolbar({ className, children, ...props }: DashboardToolbarProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

interface DashboardStatGridProps extends HTMLAttributes<HTMLDivElement> {
  columns?: DashboardGridColumns;
  children: ReactNode;
}

const statGridColumns: Record<DashboardGridColumns, string> = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4",
};

export function DashboardStatGrid({
  columns = 4,
  className,
  children,
  ...props
}: DashboardStatGridProps) {
  return (
    <div className={cn("grid min-w-0 gap-3", statGridColumns[columns], className)} {...props}>
      {children}
    </div>
  );
}
