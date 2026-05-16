import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface DashboardSectionProps {
  label: string;
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function DashboardSection({
  label,
  title,
  description,
  action,
  className,
}: DashboardSectionProps) {
  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center gap-2">
        <span className="inline-block size-2 bg-accent" />
        <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-muted-foreground">
          {label}
        </p>
      </div>
      {(title || description || action) && (
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1.5">
            {title ? (
              <h2 className="text-xl font-semibold text-txt-strong md:text-2xl">
                {title}
              </h2>
            ) : null}
            {description ? (
              <div className="max-w-3xl text-sm text-muted-foreground md:text-base">
                {description}
              </div>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      )}
    </div>
  );
}
