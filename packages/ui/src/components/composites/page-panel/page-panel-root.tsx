import * as React from "react";

import { cn } from "../../../lib/utils";
import type { PagePanelProps } from "./page-panel-types";

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
            ? "w-full rounded-3xl border border-border/34 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_82%,transparent),color-mix(in_srgb,var(--bg)_96%,transparent))] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_22px_34px_-26px_rgba(15,23,42,0.14)] ring-1 ring-border/8 backdrop-blur-md dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_24px_36px_-26px_rgba(0,0,0,0.32)]"
            : variant === "workspace"
              ? "flex min-h-[58vh] flex-col overflow-hidden rounded-3xl border border-border/34 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_82%,transparent),color-mix(in_srgb,var(--bg)_96%,transparent))] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_22px_34px_-26px_rgba(15,23,42,0.14)] ring-1 ring-border/8 backdrop-blur-md dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_24px_36px_-26px_rgba(0,0,0,0.32)]"
              : variant === "section"
                ? "w-full overflow-visible rounded-3xl border border-border/34 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_82%,transparent),color-mix(in_srgb,var(--bg)_96%,transparent))] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_22px_34px_-26px_rgba(15,23,42,0.14)] ring-1 ring-border/8 backdrop-blur-md dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_24px_36px_-26px_rgba(0,0,0,0.32)]"
                : variant === "padded"
                  ? "rounded-3xl border border-border/34 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_82%,transparent),color-mix(in_srgb,var(--bg)_96%,transparent))] px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_22px_34px_-26px_rgba(15,23,42,0.14)] ring-1 ring-border/8 backdrop-blur-md sm:px-6 sm:py-5 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_24px_36px_-26px_rgba(0,0,0,0.32)]"
                  : variant === "shell"
                    ? "relative flex min-h-0 flex-1 overflow-hidden rounded-full border border-border/44 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_80%,transparent),color-mix(in_srgb,var(--bg)_96%,transparent))] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_24px_42px_-28px_rgba(15,23,42,0.16)] ring-1 ring-border/10 backdrop-blur-md dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_26px_44px_-28px_rgba(0,0,0,0.36)]"
                    : "rounded-2xl border border-border/28 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_92%,transparent))] shadow-[inset_0_1px_0_rgba(255,255,255,0.1),inset_0_-1px_0_rgba(255,255,255,0.02)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),inset_0_-1px_0_rgba(255,255,255,0.01)]",
          className,
        )}
        {...props}
      />
    );
  },
);
