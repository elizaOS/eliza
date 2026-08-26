/**
 * Base container element every page-panel part builds on, mapping the `variant`
 * prop (surface/workspace/section/padded/shell) to layout classes over a shared
 * transparent surface. Polymorphic via `as`; the rest of the panel chrome
 * composes on top of it.
 */
import * as React from "react";

import { cn } from "../../../lib/utils";
import { Card } from "../../ui/card";
import type { PagePanelProps } from "./page-panel-types";

export const PagePanelRoot = React.forwardRef<HTMLDivElement, PagePanelProps>(
  function PagePanelRoot(
    { as, className, variant = "surface", ...props },
    ref,
  ) {
    const Component = as ?? "div";

    return (
      <Card
        asChild
        variant="transparent"
        className={cn(
          variant === "surface"
            ? "w-full"
            : variant === "workspace"
              ? "flex min-h-[58vh] flex-col overflow-hidden"
              : variant === "section"
                ? "w-full overflow-visible"
                : variant === "padded"
                  ? "px-4 py-3 sm:px-5 sm:py-4"
                  : variant === "shell"
                    ? "relative flex min-h-0 flex-1 overflow-hidden"
                    : undefined,
          className,
        )}
      >
        <Component ref={ref as never} {...props} />
      </Card>
    );
  },
);
