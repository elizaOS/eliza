// Sibling primitive mirrored at cloud/packages/ui/src/components/empty-state.tsx. The two
// workspaces (Eliza-UI and Cloud-UI) cannot depend on each other today, so
// these files are intentional siblings. When changing behavior, props, or
// visual semantics, update both — or extract to a shared package per
// docs/frontend-cleanup-2026-05-12/15-cloud-eliza-primitive-dedup.md.
import * as React from "react";
import { cn } from "../../lib/utils";

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Icon element rendered above the title */
  icon?: React.ReactNode;
  /** Main heading */
  title: string;
  /** Supporting description text */
  description?: string;
  /** Primary action button or element */
  action?: React.ReactNode;
}

export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
  (
    { icon, title, description, action, className, children, ...props },
    ref,
  ) => (
    <div
      ref={ref}
      className={cn(
        "flex flex-1 flex-col items-center justify-center p-6 text-center",
        className,
      )}
      {...props}
    >
      {icon && (
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          {icon}
        </div>
      )}
      <h3 className="mb-2 text-lg font-semibold">{title}</h3>
      {description && (
        <p className="mb-6 max-w-sm text-sm text-muted">{description}</p>
      )}
      {action}
      {children}
    </div>
  ),
);
EmptyState.displayName = "EmptyState";
