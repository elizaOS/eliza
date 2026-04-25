import { cva } from "class-variance-authority";
// biome-ignore lint/correctness/noUnusedImports: Required for this package's JSX transform in tests.
import * as React from "react";

import { cn } from "../../../lib/utils";
import type { SidebarPanelProps } from "./sidebar-types";

const sidebarPanelVariants = cva("", {
  variants: {
    variant: {
      default: "flex min-h-full flex-col gap-2 rounded-sm p-1.5 shadow-inset",
      mobile: "flex min-h-full flex-col gap-2 rounded-sm p-1.5 shadow-inset",
      "game-modal":
        "flex min-h-full flex-col gap-1.5 rounded-sm bg-black/12 p-2",
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
    <div
      data-sidebar-panel
      className={cn(sidebarPanelVariants({ variant }), className)}
      {...props}
    />
  );
}
