import { cn } from "../../../lib/utils";
import { sidebarPanelVariants } from "./sidebar-styles";
import type { SidebarPanelProps } from "./sidebar-types";

export function SidebarPanel({
  className,
  variant = "default",
  ...props
}: SidebarPanelProps) {
  return (
    <div
      data-sidebar-panel
      className={cn(sidebarPanelVariants({ variant }), className)}
      {...props}
    />
  );
}
