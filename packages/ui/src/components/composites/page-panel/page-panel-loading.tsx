/**
 * Loading placeholder for a page panel: a centered spinner with optional
 * heading/description, wrapped in a PagePanelRoot for consistent panel spacing.
 */
import { ContentState } from "./content-state";
import type { PageLoadingStateProps } from "./page-panel-types";

export function PageLoadingState({
  className,
  description,
  heading,
  variant = "panel",
  ...props
}: PageLoadingStateProps) {
  return (
    <ContentState
      state="loading"
      placement={variant}
      className={className}
      description={description}
      heading={heading}
      {...props}
    />
  );
}
