import { Badge } from "@elizaos/app-core";
import type { ReactNode } from "react";

export function WidgetSection({
  title,
  icon,
  count,
  action,
  children,
  testId,
}: {
  title: string;
  icon: ReactNode;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section
      data-testid={testId}
      className="rounded-xl border border-border/60 bg-bg-accent/25"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-bg-hover text-muted">
            {icon}
          </span>
          <span className="truncate text-xs font-semibold uppercase tracking-[0.08em] text-muted">
            {title}
          </span>
          {typeof count === "number" ? (
            <Badge variant="secondary" className="shrink-0 text-2xs">
              {count}
            </Badge>
          ) : null}
        </div>
        {action}
      </div>
      <div className="px-3 py-3">{children}</div>
    </section>
  );
}

export function EmptyWidgetState({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-center justify-center gap-2 py-5 text-center">
        <span className="text-muted/50">{icon}</span>
        <p className="text-sm text-muted">{title}</p>
        {description ? (
          <p className="text-xs text-muted/70">{description}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}
