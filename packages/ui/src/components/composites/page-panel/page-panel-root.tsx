import * as React from "react";

import { cn } from "../../../lib/utils";
import type { PagePanelProps } from "./page-panel-types";

const BASE_SURFACE = "border border-border bg-card shadow-xs";

export const PagePanelRoot = React.forwardRef<HTMLDivElement, PagePanelProps>(
  function PagePanelRoot(
    { as, className, variant = "surface", ...props },
    ref,
  ) {
    const Component = as ?? "div";

    return (
      <Component
        ref={ref as never}
        className={cn(
          variant === "surface"
            ? `w-full rounded-sm ${BASE_SURFACE}`
            : variant === "workspace"
              ? `flex min-h-[58vh] flex-col overflow-hidden rounded-sm ${BASE_SURFACE}`
              : variant === "section"
                ? `w-full overflow-visible rounded-sm ${BASE_SURFACE}`
                : variant === "padded"
                  ? `rounded-sm px-5 py-4 sm:px-6 sm:py-5 ${BASE_SURFACE}`
                  : variant === "shell"
                    ? `relative flex min-h-0 flex-1 overflow-hidden rounded-sm ${BASE_SURFACE}`
                    : `rounded-sm ${BASE_SURFACE}`,
          className,
        )}
        {...props}
      />
    );
  },
);
