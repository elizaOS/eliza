/**
 * Loading placeholder for a page panel: a centered spinner with optional
 * heading/description, wrapped in a PagePanelRoot for consistent panel spacing.
 */
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
          "flex min-h-[42vh] flex-col items-center justify-center px-4 py-8 text-center",
          className,
        )}
        {...props}
      >
        <Spinner className="h-5 w-5 text-muted" />
        <div className="mt-4 max-w-md space-y-2">
          <div className="text-base font-medium text-txt-strong">{heading}</div>
          {description ? <div className="sr-only">{description}</div> : null}
        </div>
      </PagePanelRoot>
    );
  }

  if (variant === "workspace") {
    return (
      <PagePanelRoot
        variant="workspace"
        className={cn(
          "items-center justify-center px-4 py-8 text-center",
          className,
        )}
        {...props}
      >
        <Spinner className="h-5 w-5 text-muted" />
        <div className="mt-4 max-w-md space-y-2">
          <div className="text-base font-medium text-txt-strong">{heading}</div>
          {description ? <div className="sr-only">{description}</div> : null}
        </div>
      </PagePanelRoot>
    );
  }

  return (
    <div
      className={cn(
        "flex min-h-[12rem] flex-col items-center justify-center px-4 py-8 text-center",
        className,
      )}
      {...props}
    >
      <Spinner className="h-5 w-5 text-muted" />
      <div className="mt-4 max-w-md space-y-2">
        <div className="text-base font-medium text-txt-strong">{heading}</div>
        {description ? <div className="sr-only">{description}</div> : null}
      </div>
    </div>
  );
}
