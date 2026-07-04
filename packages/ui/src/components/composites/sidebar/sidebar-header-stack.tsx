/**
 * Vertically-spaced container for a sidebar header's stacked rows, carrying the
 * expand/collapse transition. The bare layout primitive under `SidebarHeader`.
 */
import { cn } from "../../../lib/utils";
import type { SidebarHeaderStackProps } from "./sidebar-types";

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
