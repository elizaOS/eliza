import * as React from "react";
import { cn } from "../../../lib/utils";
import type { SidebarBodyProps } from "./sidebar-types";

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
