import type { ReactNode } from "react";

export function WidgetSection({
  title,
  icon,
  action,
  children,
  testId,
  onTitleClick,
}: {
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  testId: string;
  /** When set, the title area becomes a button navigating elsewhere. */
  onTitleClick?: () => void;
}) {
  const titleContent = (
    <>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-bg-hover text-muted">
        {icon}
      </span>
      <span className="truncate text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
        {title}
      </span>
    </>
  );
  return (
    <section data-testid={testId} className="space-y-2">
      <div className="flex items-center justify-between gap-3 px-0.5">
        {onTitleClick ? (
          <button
            type="button"
            onClick={onTitleClick}
            className="flex min-w-0 items-center gap-2 rounded-[var(--radius-sm)] bg-transparent text-left transition-colors hover:text-txt"
          >
            {titleContent}
          </button>
        ) : (
          <div className="flex min-w-0 items-center gap-2">{titleContent}</div>
        )}
        {action}
      </div>
      <div className="text-xs">{children}</div>
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
        <p className="text-2xs text-muted">{title}</p>
        {description ? (
          <p className="text-3xs text-muted/70">{description}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}
