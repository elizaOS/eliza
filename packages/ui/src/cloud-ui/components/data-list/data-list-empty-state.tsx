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
      className={cn("border border-white/10 bg-black/40 p-8 md:p-12", className)}
    >
      <div className="mx-auto flex max-w-sm flex-col items-center justify-center space-y-4 text-center">
        {Icon ? (
          <div className="flex size-12 items-center justify-center border border-white/10 bg-white/[0.03]">
            <Icon className={cn("h-6 w-6 text-white/40", iconClassName)} />
          </div>
        ) : null}
        <div className="space-y-1.5">
          <p className="font-medium text-white">{title}</p>
          {description ? (
            <p className="text-sm text-white/74">{description}</p>
          ) : null}
        </div>
        {action ? <div className="pt-2">{action}</div> : null}
      </div>
    </div>
  );
}

export type { DataListEmptyStateProps };
