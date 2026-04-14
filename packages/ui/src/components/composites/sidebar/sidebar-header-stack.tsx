import { cn } from "../../../lib/utils";
import { sidebarHeaderStackClassName } from "./sidebar-styles";
import type { SidebarHeaderStackProps } from "./sidebar-types";

export function SidebarHeaderStack({
  className,
  ...props
}: SidebarHeaderStackProps) {
  return (
    <div className={cn(sidebarHeaderStackClassName, className)} {...props} />
  );
}
