import * as React from "react";
import { cn } from "../../../lib/utils";
import { sidebarBodyClassName } from "./sidebar-styles";
import type { SidebarBodyProps } from "./sidebar-types";

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
