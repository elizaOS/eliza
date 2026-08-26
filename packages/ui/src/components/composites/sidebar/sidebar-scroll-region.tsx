/**
 * The scrolling region of a sidebar body — the overflow container that holds the
 * item list with a custom scrollbar and stable gutter, per variant.
 */
// biome-ignore lint/correctness/noUnusedImports: Required for this package's JSX transform in tests.
import * as React from "react";

import { cn } from "../../../lib/utils";
import { Card } from "../../ui/card";
import type { SidebarScrollRegionProps } from "./sidebar-types";

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
