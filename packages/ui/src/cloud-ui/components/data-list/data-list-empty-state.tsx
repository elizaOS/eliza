import type { ComponentType, ReactNode } from "react";
import { cn } from "../../lib/utils";

interface DataListEmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  action?: ReactNode;
  className?: string;
  iconClassName?: string;
}

export function DataListEmptyState({
  title,
  description,
  icon: Icon,
  action,
  className,
  iconClassName,
}: DataListEmptyStateProps) {
  return (
    <div
      data-slot="data-list-empty-state"
      className={cn(
        "rounded-sm border border-border bg-bg-elevated p-8 text-txt md:p-12",
        className,
      )}
    >
      <div className="mx-auto flex max-w-sm flex-col items-center justify-center space-y-4 text-center">
        {Icon ? (
          <div className="flex size-12 items-center justify-center rounded-sm border border-border bg-bg-muted">
            <Icon
              className={cn("h-6 w-6 text-muted-foreground", iconClassName)}
            />
          </div>
        ) : null}
        <div className="space-y-1.5">
          <p className="font-medium text-txt-strong">{title}</p>
          {description ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ? <div className="pt-2">{action}</div> : null}
      </div>
    </div>
  );
}

export type { DataListEmptyStateProps };
