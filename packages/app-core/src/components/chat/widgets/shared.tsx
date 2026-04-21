import type { ReactNode } from "react";

export function WidgetSection({
  title,
  icon,
  action,
  children,
  testId,
}: {
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section data-testid={testId} className="space-y-2">
      <div className="flex items-center justify-between gap-3 px-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-bg-hover text-muted">
            {icon}
          </span>
          <span className="truncate text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
            {title}
          </span>
        </div>
        {action}
      </div>
      <div>{children}</div>
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
        <p className="text-xs text-muted">{title}</p>
        {description ? (
          <p className="text-xs text-muted/70">{description}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}
