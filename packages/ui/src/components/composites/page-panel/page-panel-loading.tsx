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
        "flex min-h-[18rem] flex-col items-center justify-center rounded-3xl border border-dashed border-border/32 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] px-6 py-12 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_20px_28px_-24px_rgba(15,23,42,0.12)] backdrop-blur-sm dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_22px_30px_-24px_rgba(0,0,0,0.28)]",
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
