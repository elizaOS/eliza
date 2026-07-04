/**
 * Empty-state card for dashboard data lists (icon, message, optional action).
 */
import type { ComponentType, ReactNode } from "react";
import { EmptyState } from "../../../components/ui/empty-state";
import { cn } from "../../lib/utils";

interface DataListEmptyStateProps {
  title: string;
  description?: string;
  icon?: ComponentType<{ className?: string }>;
  action?: ReactNode;
  className?: string;
}

/**
 * Empty state for the dashboard data-list surfaces — the shared `EmptyState`
 * primitive wrapped in the elevated card frame the data lists use. Takes the
 * icon as a component (callers pass a lucide icon) rather than a rendered node.
 */
export function DataListEmptyState({
  title,
  description,
  icon: Icon,
  action,
  className,
}: DataListEmptyStateProps) {
  return (
    <EmptyState
      data-slot="data-list-empty-state"
      variant="minimal"
      className={cn(
        "rounded-sm border border-border bg-bg-elevated p-8 md:p-12",
        className,
      )}
      icon={Icon ? <Icon className="h-6 w-6" /> : undefined}
      title={title}
      description={description}
      action={action}
    />
  );
}

export type { DataListEmptyStateProps };
