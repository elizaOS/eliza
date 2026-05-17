import { cva } from "class-variance-authority";
// biome-ignore lint/correctness/noUnusedImports: Required for this package's JSX transform in tests.
import * as React from "react";

import { cn } from "../../../lib/utils";
import type { SidebarScrollRegionProps } from "./sidebar-types";

const sidebarScrollRegionVariants = cva("", {
  variants: {
    variant: {
      default:
        "custom-scrollbar min-h-0 w-full min-w-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-3 pt-3 supports-[scrollbar-gutter:stable]:[scrollbar-gutter:stable]",
      mobile:
        "custom-scrollbar min-h-0 w-full min-w-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-3 pt-3 supports-[scrollbar-gutter:stable]:[scrollbar-gutter:stable]",
      "game-modal":
        "custom-scrollbar flex-1 min-h-0 w-full overflow-y-auto p-2.5",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

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
