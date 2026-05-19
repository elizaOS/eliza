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
          ? "min-h-[14rem] rounded-sm border border-dashed border-border bg-card px-5 py-10"
          : "min-h-[18rem] rounded-sm border border-dashed border-border bg-card px-6 py-12 shadow-xs",
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
