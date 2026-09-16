/**
 * Generic "nothing here yet" state for a page panel: wraps the primitive
 * EmptyState in a PagePanelRoot so the placeholder inherits panel spacing.
 */
import { ContentState } from "./content-state";
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
  return (
    <ContentState
      state="empty"
      placement={variant}
      className={className}
      description={description}
      action={action}
      title={title}
      {...props}
    >
      {children}
    </ContentState>
  );
}
