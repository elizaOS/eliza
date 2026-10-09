import { cva } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../../utils/cn";
import { Card } from "../../ui/card";
import { SidebarSearchBar, type SidebarSearchBarProps } from "../searchbar";
import type {
  SidebarBodyProps,
  SidebarHeaderStackProps,
  SidebarPanelProps,
  SidebarScrollRegionProps,
} from "./sidebar-types";

const sidebarBodyClassName =
  "flex min-h-0 flex-1 flex-col overflow-hidden transform-gpu transition-[opacity,transform] duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform] motion-reduce:transform-none motion-reduce:transition-none";

export const SidebarBody = React.forwardRef<HTMLDivElement, SidebarBodyProps>(
  function SidebarBody({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(sidebarBodyClassName, className)}
        {...props}
      />
    );
  },
);

const sidebarHeaderStackClassName =
  "space-y-2.5 transform-gpu transition-[opacity,transform] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transform-none motion-reduce:transition-none";

export function SidebarHeaderStack({
  className,
  ...props
}: SidebarHeaderStackProps) {
  return (
    <div className={cn(sidebarHeaderStackClassName, className)} {...props} />
  );
}

export interface SidebarHeaderProps
  extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  search?: Omit<SidebarSearchBarProps, "className"> &
    React.RefAttributes<HTMLInputElement>;
  searchClassName?: string;
}

export function SidebarHeader({
  children,
  search,
  searchClassName,
  ...props
}: SidebarHeaderProps) {
  return (
    <SidebarHeaderStack {...props}>
      {search ? (
        <SidebarSearchBar className={searchClassName} {...search} />
      ) : null}
      {children}
    </SidebarHeaderStack>
  );
}

const sidebarPanelVariants = cva("", {
  variants: {
    variant: {
      default: "flex min-h-full flex-col gap-2 p-1.5",
      mobile: "flex min-h-full flex-col gap-2 p-1.5",
      "game-modal": "flex min-h-full flex-col gap-1.5 p-2",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export function SidebarPanel({
  className,
  variant = "default",
  ...props
}: SidebarPanelProps) {
  return (
    <Card
      asChild
      surface={variant === "game-modal" ? "backgroundSubtle" : "transparent"}
    >
      <div
        data-sidebar-panel
        className={cn(sidebarPanelVariants({ variant }), className)}
        {...props}
      />
    </Card>
  );
}

export function SidebarScrollRegion({
  className,
  tabIndex = 0,
  variant = "default",
  ...props
}: SidebarScrollRegionProps) {
  return (
    <Card
      surface="transparent"
      radius="none"
      scrollbar="styled"
      tabIndex={tabIndex}
      className={cn(
        variant === "game-modal"
          ? "min-h-0 w-full flex-1 overflow-y-auto p-2.5"
          : "min-h-0 w-full min-w-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-3 pt-3 supports-[scrollbar-gutter:stable]:[scrollbar-gutter:stable]",
        className,
      )}
      {...props}
    />
  );
}
