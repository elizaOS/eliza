import { cn } from "../../../lib/utils";
import { Spinner } from "../../ui/spinner";
import { PagePanelRoot } from "./page-panel-root";
import type { PageLoadingStateProps } from "./page-panel-types";

export function PageLoadingState({
  className,
  description,
  heading,
  variant = "panel",
  ...props
}: PageLoadingStateProps) {
  if (variant === "surface") {
    return (
      <PagePanelRoot
        className={cn(
          "flex min-h-[58vh] flex-col items-center justify-center px-6 py-10 text-center",
          className,
        )}
        {...props}
      >
        <Spinner className="h-5 w-5 text-muted" />
        <div className="mt-4 max-w-md space-y-2">
          <div className="text-base font-medium text-txt-strong">{heading}</div>
          {description ? (
            <div className="text-sm leading-relaxed text-muted">
              {description}
            </div>
          ) : null}
        </div>
      </PagePanelRoot>
    );
  }

  if (variant === "workspace") {
    return (
      <PagePanelRoot
        variant="workspace"
        className={cn(
          "items-center justify-center px-6 py-10 text-center",
          className,
        )}
        {...props}
      >
        <Spinner className="h-5 w-5 text-muted" />
        <div className="mt-4 max-w-md space-y-2">
          <div className="text-base font-medium text-txt-strong">{heading}</div>
          {description ? (
            <div className="text-sm leading-relaxed text-muted">
              {description}
            </div>
          ) : null}
        </div>
      </PagePanelRoot>
    );
  }

  return (
    <div
      className={cn(
        "flex min-h-[18rem] flex-col items-center justify-center rounded-sm border border-dashed border-border bg-card px-6 py-12 text-center shadow-xs",
        className,
      )}
      {...props}
    >
      <Spinner className="h-5 w-5 text-muted" />
      <div className="mt-4 max-w-md space-y-2">
        <div className="text-base font-medium text-txt-strong">{heading}</div>
        {description ? (
          <div className="text-sm leading-relaxed text-muted">
            {description}
          </div>
        ) : null}
      </div>
    </div>
  );
}
