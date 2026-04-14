import { cn } from "../../../lib/utils";
import { sidebarScrollRegionVariants } from "./sidebar-styles";
import type { SidebarScrollRegionProps } from "./sidebar-types";

export function SidebarScrollRegion({
  className,
  variant = "default",
  ...props
}: SidebarScrollRegionProps) {
  return (
    <div
      className={cn(sidebarScrollRegionVariants({ variant }), className)}
      {...props}
    />
  );
}
