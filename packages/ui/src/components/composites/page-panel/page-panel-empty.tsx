import { cn } from "../../../lib/utils";
import { EmptyState } from "../../ui/empty-state";
import { PagePanelRoot } from "./page-panel-root";
import type { PageEmptyStateProps } from "./page-panel-types";

export function PageEmptyState({
  action,
  children,
  className,
  description,
  title,
  variant = "panel",
  ...props
}: PageEmptyStateProps) {
  if (variant === "surface") {
    return (
      <PagePanelRoot
        className={cn(
          "flex min-h-[58vh] flex-col items-center justify-center px-6 py-10 text-center",
          className,
        )}
        {...props}
      >
        <div className="max-w-md space-y-2">
          <div className="text-base font-medium text-txt-strong">{title}</div>
          {description ? (
            <div className="text-sm leading-relaxed text-muted">
              {description}
            </div>
          ) : null}
        </div>
        {action ? <div className="mt-4">{action}</div> : null}
        {children}
      </PagePanelRoot>
    );
  }

  if (variant === "workspace") {
    return (
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10 text-center",
          className,
        )}
        {...props}
      >
        <div className="max-w-md space-y-2">
          <div className="text-base font-medium text-txt-strong">{title}</div>
          {description ? (
            <div className="text-sm leading-relaxed text-muted">
              {description}
            </div>
          ) : null}
        </div>
        {action ? <div className="mt-4">{action}</div> : null}
        {children}
      </div>
    );
  }

  return (
    <EmptyState
      className={cn(
        variant === "inset"
          ? "min-h-[14rem] rounded-2xl border border-dashed border-border/28 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_74%,transparent),color-mix(in_srgb,var(--bg)_93%,transparent))] px-5 py-10 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),inset_0_-1px_0_rgba(255,255,255,0.02)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),inset_0_-1px_0_rgba(255,255,255,0.01)]"
          : "min-h-[18rem] rounded-3xl border border-dashed border-border/32 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] px-6 py-12 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_20px_28px_-24px_rgba(15,23,42,0.12)] backdrop-blur-sm dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_22px_30px_-24px_rgba(0,0,0,0.28)]",
        className,
      )}
      description={description}
      title={title}
      {...props}
    >
      {children}
      {action ? <div className="mt-4">{action}</div> : null}
    </EmptyState>
  );
}
