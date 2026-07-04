/**
 * Base container element every page-panel part builds on, mapping the `variant`
 * prop (surface/workspace/section/padded/shell) to layout classes over a shared
 * transparent surface. Polymorphic via `as`; the rest of the panel chrome
 * composes on top of it.
 */
import * as React from "react";

import { cn } from "../../../lib/utils";
import type { PagePanelProps } from "./page-panel-types";

const BASE_SURFACE = "bg-transparent";

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
            ? `w-full ${BASE_SURFACE}`
            : variant === "workspace"
              ? `flex min-h-[58vh] flex-col overflow-hidden ${BASE_SURFACE}`
              : variant === "section"
                ? `w-full overflow-visible ${BASE_SURFACE}`
                : variant === "padded"
                  ? `px-4 py-3 sm:px-5 sm:py-4 ${BASE_SURFACE}`
                  : variant === "shell"
                    ? `relative flex min-h-0 flex-1 overflow-hidden ${BASE_SURFACE}`
                    : BASE_SURFACE,
          className,
        )}
        {...props}
      />
    );
  },
);
