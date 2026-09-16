/**
 * Inset panel surface for grouped sidebar content, with default/mobile/game-modal
 * skins. Sits inside the sidebar body to visually bracket a section of items.
 */
import { cva } from "class-variance-authority";
// biome-ignore lint/correctness/noUnusedImports: Required for this package's JSX transform in tests.
import * as React from "react";

import { cn } from "../../../lib/utils";
import { Card } from "../../ui/card";
import type { SidebarPanelProps } from "./sidebar-types";

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
